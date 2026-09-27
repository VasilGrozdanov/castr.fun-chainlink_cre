import {
  CronCapability, hexToBase64,
  EVMClient,
  HTTPClient,
  consensusIdenticalAggregation,
  encodeCallMsg,
  getNetwork,
  bytesToHex,
  bytesToBase64,
  json,
  ok,
  prepareReportRequest,
  LAST_FINALIZED_BLOCK_NUMBER,
  TxStatus,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
  type EVMLog,
} from "@chainlink/cre-sdk"
import {
  type Address,
  parseAbi, keccak256, toBytes,
  encodeFunctionData,
  decodeFunctionResult,
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  zeroAddress,
} from "viem"
import { z } from "zod"

type Config = {
  cronSchedule: string
  chainSelectorName: string
  rewardResolverAddress: string
  feeAccountAddress: string
  subgraphUrl: string
  gracePeriodSeconds: number
  reportGasLimit: string
}

// Minimal ABI - only the reads/events this workflow needs. Keep in sync with
// checkEligibility()/s_lastWinnerTimestamp()/WinnerPicked in src/RewardResolver.sol.
const rewardResolverAbi = parseAbi([
  "function checkEligibility() view returns (bool)",
  "function s_lastWinnerTimestamp() view returns (uint256)",
  "event WinnerPicked(address indexed winner, uint256 timestamp)",
])

const subgraphResponseSchema = z.object({
  data: z
    .object({
      pools: z.array(z.object({ tokenAddress: z.string() })).optional(),
    })
    .optional(),
})

const getEvmClient = (runtime: Runtime<Config>): EVMClient => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(
      `Unknown chain selector name: ${runtime.config.chainSelectorName}`,
    )
  }
  return new EVMClient(network.chainSelector.selector)
}

const readCheckEligibility = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
): boolean => {
  const callData = encodeFunctionData({
    abi: rewardResolverAbi,
    functionName: "checkEligibility",
  })
  const result = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.rewardResolverAddress as Address,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  return decodeFunctionResult({
    abi: rewardResolverAbi,
    functionName: "checkEligibility",
    data: bytesToHex(result.data),
  })
}

const readLastWinnerTimestamp = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
): bigint => {
  const callData = encodeFunctionData({
    abi: rewardResolverAbi,
    functionName: "s_lastWinnerTimestamp",
  })
  const result = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.rewardResolverAddress as Address,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  return decodeFunctionResult({
    abi: rewardResolverAbi,
    functionName: "s_lastWinnerTimestamp",
    data: bytesToHex(result.data),
  })
}

// Runs independently on each DON node (node mode) so the bearer token is read once in DON
// mode and passed in as an argument - it is never available inside this closure directly.
const fetchWinner = (
  nodeRuntime: NodeRuntime<Config>,
  bearerToken: string,
  subgraphUrl: string,
  sinceTimestamp: string,
): Address => {
  const httpClient = new HTTPClient()
  const query = `{pools(where: {isRewarded: false, creationTimestamp_gte: ${sinceTimestamp}}, orderDirection: asc, orderBy: score, first: 1){tokenAddress}}`
  const payload = JSON.stringify({
    query,
    operationName: "Subgraphs",
    variables: {},
  })

  const response = httpClient
    .sendRequest(nodeRuntime, {
      url: subgraphUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: bytesToBase64(new TextEncoder().encode(payload)),
      cacheSettings: { store: false },
    })
    .result()

  if (!ok(response)) {
    throw new Error(`Subgraph HTTP ${response.statusCode}`)
  }

  const parsed = subgraphResponseSchema.parse(json(response))
  const pool = parsed.data?.pools?.[0]
  return (pool?.tokenAddress as Address | undefined) ?? zeroAddress
}

/**
 * Handler A - Cron, ~REWARD_INTERVAL. Replaces RewardResolver's old checkUpkeep/performUpkeep +
 * Chainlink Functions round trip: reads the same eligibility gate the contract re-checks in
 * onReport, fetches the next winner token from the subgraph, and reports it to RewardResolver.
 */
const onCronTrigger = (runtime: Runtime<Config>): string => {
  const evmClient = getEvmClient(runtime)

  const eligible = readCheckEligibility(runtime, evmClient)
  if (!eligible) {
    runtime.log("RewardResolver not eligible for a new winner this round.")
    return "not-eligible"
  }

  const lastWinnerTimestamp = readLastWinnerTimestamp(runtime, evmClient)
  const sinceTimestamp = (
    lastWinnerTimestamp - BigInt(runtime.config.gracePeriodSeconds)
  ).toString()

  const bearerToken = runtime
    .getSecret({ id: "SUBGRAPH_BEARER_TOKEN_SECRET" })
    .result().value

  const winner = runtime
    .runInNodeMode(fetchWinner, consensusIdenticalAggregation<Address>())(
      bearerToken,
      runtime.config.subgraphUrl,
      sinceTimestamp,
    )
    .result()

  if (winner === zeroAddress) {
    runtime.log("No eligible token found this round.")
    return "no-winner"
  }

  const encoded = encodeAbiParameters(parseAbiParameters("address"), [
    winner,
  ])
  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.rewardResolverAddress,
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.reportGasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `RewardResolver report write failed: ${txResult.errorMessage || txResult.txStatus}`,
    )
  }

  runtime.log(
    `Reported winner ${winner} to RewardResolver. tx=${bytesToHex(txResult.txHash ?? new Uint8Array(32))}`,
  )
  return winner
}

/**
 * Handler B - EVM Log trigger on RewardResolver's WinnerPicked event. Replaces FeeAccount's old
 * poll-based checkUpkeep/performUpkeep: reports the winner to FeeAccount to trigger distribution.
 */
const onWinnerPickedLog = (
  runtime: Runtime<Config>,
  triggerEvent: EVMLog,
): string => {
  // triggerEvent.topics/data arrive as raw Uint8Array (not hex strings) - decodeEventLog needs hex.
  const topics = triggerEvent.topics.map((topic) => bytesToHex(topic)) as [
    `0x${string}`,
    ...`0x${string}`[],
  ]
  const decoded = decodeEventLog({
    abi: rewardResolverAbi,
    eventName: "WinnerPicked",
    topics,
    data: bytesToHex(triggerEvent.data),
  })
  const winner = decoded.args.winner as Address

  if (winner === zeroAddress) {
    runtime.log("WinnerPicked emitted with no winner - nothing to distribute.")
    return "no-winner"
  }

  const evmClient = getEvmClient(runtime)
  const encoded = encodeAbiParameters(parseAbiParameters("address"), [
    winner,
  ])
  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.feeAccountAddress,
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.reportGasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `FeeAccount report write failed: ${txResult.errorMessage || txResult.txStatus}`,
    )
  }

  runtime.log(
    `Reported winner ${winner} to FeeAccount for distribution. tx=${bytesToHex(txResult.txHash ?? new Uint8Array(32))}`,
  )
  return winner
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
  })
  if (!network) {
    throw new Error(
      `Unknown chain selector name: ${config.chainSelectorName}`,
    )
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  // Compute the event signature hash for WinnerPicked(address,uint256)
  const winnerPickedSignature = keccak256(toBytes("WinnerPicked(address,uint256)"))

  return [
    handler(cron.trigger({ schedule: config.cronSchedule }), onCronTrigger),
    handler(
      evmClient.logTrigger({
        addresses: [hexToBase64(config.rewardResolverAddress)],
        topics: [
          { values: [hexToBase64(winnerPickedSignature)] }, // Listen only for WinnerPicked events
        ],
      }),
      onWinnerPickedLog,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
