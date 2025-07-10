import pc from "picocolors"
import {
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
} from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import config from "@/config"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import { sleep } from "bun"
import {
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "@/api/chat/chat"
import { ragPipelineConfig, RagPipelineStages } from "@/api/chat/types"
import {
  extractFileIdsFromMessage,
  isMessageWithContext,
} from "@/api/chat/utils"

const { defaultBestModel} = config;
const Logger = getLogger(Subsystem.Eval)
const hardcodedModelId = defaultBestModel || Models.Claude_3_5_Sonnet
const hardcodedAgentPrompt = JSON.stringify({
  role: "Assistant",
  instructions: `
You are an experienced solution architect responsible for guiding users through the integration process of the Digital Payment Integration Platform (DPIP) fraud registry. Your role is to provide technical assistance, track user progress, and offer solutions to integration challenges.

As a solution architect, your task is to analyze the user's situation and provide expert guidance through the DPIP integration process. Here are the key components of your role:

1. Integration Phases:
Familiarize yourself with the following integration phases and their tasks:

**Phase 1: Preparation**
- 1.1 Access Integration Docs (API specs, SDK usage, error codes)
- 1.2 Setup Cryptographic Credentials:
  - Generate RSA public-private key pair (PEM format)
  - Exchange Hash Key and IV for AES encryption/HMAC
  - Provide X.509 certificate (if mutual TLS required)
- 1.3 SDK Selection:
  - Bloom SDK (fraud screening & identifier processing)
  - Ingestion SDK (pushing identifiers and entity data)
  - Screening SDK (real-time decisioning) 
  - Dispute SDK (raise/view fraud disputes)
  - Testing SDK (sandbox and health checks)
- 1.4 Environment Setup (whitelist domains/IPs, TLS 1.2+, secure key storage)

**Phase 2: Integration**
- 2.1 Ingestion API via SDK (push identifiers, handle retries, async callbacks)
- 2.2 Screening API via SDK (real-time screening, encrypted payloads, handle FRAUD/SUSPECT/NO_MATCH responses)
- 2.3 Dispute API via SDK (raise disputes, attach evidence, query status)
- 2.4 Testing & Sandbox Integration (run predefined flows, validate responses)
- 2.5 Optional: Webhooks Setup (async results, challenge-response verification)

**Phase 3: Validation & Go-Live**
- 3.1 Partner Self-Test & Certification (complete checklist, run test scenarios, capture logs)
- 3.2 Joint UAT (edge cases, failure paths, volume testing)
- 3.3 Go-Live Checklist (secure key storage, monitoring, rate limits, support contacts)
- 3.4 Production Whitelisting & Enablement (production IPs, endpoint configs, enable fraud rules)

**Optional Enhancements**
- Audit Trail Integration
- Dashboard Access 
- SLAs & Alerts Setup

2. Analysis and Response Process:
Before providing your response, conduct an integration analysis by completing the following steps in <analysis_and_planning> tags:

a. Identify the current phase and task based on the user's input.
b. Extract relevant information from the user input.
c. Determine if the user has completed a task, needs guidance, or is facing a technical challenge.
d. Identify any specific challenges or roadblocks mentioned by the user.
e. Assess the user's technical expertise level based on their input.
f. Plan your response, including next steps or specific technical guidance.
g. Consider any potential roadblocks or common integration issues related to the current task.
h. Prepare solution-oriented advice that addresses the user's current needs.
i. Prioritize the most critical information or guidance needed for the user at this stage.

3. Guidance and Support:
Based on your analysis, provide appropriate guidance:
- For a new phase: Offer an overview of the phase and introduce its first task.
- For an ongoing phase: Provide detailed guidance on the current task, including best practices and potential pitfalls.
- For a completed task: Confirm completion, highlight key points, and introduce the next task.
- For technical inquiries: Offer specific, actionable advice related to the current task or challenge.

4. Technical Expertise:
Be prepared to provide detailed information on:
- SDK usage and purpose
- Cryptographic setup and troubleshooting
- API endpoints and parameters
- Testing scenarios and response validation
- Integration best practices and common pitfalls

5. Progress Tracking:
Maintain and display the user's progress using the following format:

\`\`\`markdown
## DPIP Integration Progress
[Phase 1 status] Phase 1: Preparation
[Phase 2 status] Phase 2: Integration [CURRENT TASK IF APPLICABLE]
[Phase 3 status] Phase 3: Validation & Go-Live
\`\`\`

Use the following markers for phase status:
- [x] for completed phases
- [>] for the current phase
- [ ] for upcoming phases

6. Communication Style:
Maintain a professional, supportive, and solution-oriented tone. Your goal is to empower the user with knowledge and guide them through any challenges they may face during the integration process.

7. Output Format:
Provide your responses in the following markdown format:

\`\`\`markdown
## DPIP Integration Progress
[Progress display]

[Your analysis and guidance for the user, including:
- Current phase and task overview
- Technical explanations or solutions
- Best practices and potential pitfalls
- Next steps or actionable advice]

[If applicable: Specific questions to gather more information or clarify the user's needs]
\`\`\`

Tailor your response to the user's needs, offering clear, actionable guidance to facilitate a smooth DPIP integration process.
`
})

const myEmail = "oindrila.banerjee@juspay.in"
const workspaceId = "i3acjjlykgjyamw51qbwhhiu"

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

type EvalData = {
  input: string
  isReasoningEnabled?: boolean
  attachmentFileIds?: string[]
  previousMessages?: Array<{
    role: string
    content: string
    messageRole: MessageRole
    fileIds?: string[]
  }>
  expected: {
    hasAnswer: boolean
    answerType: "conversation" | "rag" | "context"
    hasCitations: boolean
    citationCount?: number
    hasTitle?: boolean
    queryRewrite?: string
    errorExpected?: boolean
    errorMessage?: string
  }
  context?: {
    fileIds?: string[]
    hasContext: boolean
  }
}

type EvalResult = {
  input: string
  output: {
    answer?: string
    citations?: any[]
    title?: string
    queryRewrite?: string
    answerType: "conversation" | "rag" | "context" | "error"
    reasoning?: string
    cost?: number
    error?: string
  }
  expected: EvalData["expected"]
  score: number
  metrics: {
    answerTypeMatch: boolean
    citationMatch: boolean
    hasAnswerMatch: boolean
    titleMatch: boolean
    queryRewriteMatch: boolean
    errorMatch: boolean
  }
  rawOutput?: string
  processingTime: number
}

const loadTestData = (): EvalData[] => {
  try {
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "eval-data",
      "test-queries.json",
    )
    const data = fs.readFileSync(filePath, "utf-8")
    const parsedData = JSON.parse(data)
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array")
    return parsedData
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

function evaluateResponse(result: EvalResult): number {
  const { output, expected, metrics } = result

  console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########")
  console.log("Generated answer type:", output.answerType)
  console.log("Expected answer type:", expected.answerType)
  console.log("Has answer:", !!output.answer)
  console.log("Expected has answer:", expected.hasAnswer)
  console.log("Citations count:", output.citations?.length || 0)
  console.log("Expected citations:", expected.hasCitations ? "yes" : "no")

  let score = 0
  let totalChecks = 0

  // Check answer type match
  metrics.answerTypeMatch = output.answerType === expected.answerType
  if (metrics.answerTypeMatch) score += 1
  totalChecks += 1

  // Check if answer presence matches expectation
  metrics.hasAnswerMatch = !!output.answer === expected.hasAnswer
  if (metrics.hasAnswerMatch) score += 1
  totalChecks += 1

  // Check citations
  const hasCitations = (output.citations?.length || 0) > 0
  metrics.citationMatch = hasCitations === expected.hasCitations
  if (metrics.citationMatch) score += 1
  totalChecks += 1

  // Check citation count if specified
  if (expected.citationCount !== undefined) {
    const citationCountMatch =
      (output.citations?.length || 0) === expected.citationCount
    if (citationCountMatch) score += 1
    totalChecks += 1
  }

  // Check title generation for new chats
  if (expected.hasTitle !== undefined) {
    metrics.titleMatch = !!output.title === expected.hasTitle
    if (metrics.titleMatch) score += 1
    totalChecks += 1
  }

  // Check query rewrite
  if (expected.queryRewrite !== undefined) {
    metrics.queryRewriteMatch =
      !!output.queryRewrite === !!expected.queryRewrite
    if (metrics.queryRewriteMatch) score += 1
    totalChecks += 1
  }

  // Check error handling
  if (expected.errorExpected !== undefined) {
    metrics.errorMatch = !!output.error === expected.errorExpected
    if (metrics.errorMatch) score += 1
    totalChecks += 1
  }

  const finalScore = totalChecks > 0 ? score / totalChecks : 0

  console.log(pc.green(`Score: ${(finalScore * 100).toFixed(1)}%`))
  console.log(`Metrics: ${JSON.stringify(metrics, null, 2)}`)

  if (finalScore >= 0.8) {
    console.log(pc.green("✅ Excellent match"))
  } else if (finalScore >= 0.6) {
    console.log(pc.yellow("⚠️ Good match"))
  } else if (finalScore >= 0.4) {
    console.log(pc.yellow("⚠️ Partial match"))
  } else {
    console.log(pc.red("❌ Poor match"))
  }

  return finalScore
}

function saveEvalResults(
  evaluation: { averageScore: number; results: EvalResult[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.json`
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
    fileName,
  )

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
  )
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true })
    Logger.info(`Created directory: ${evalResultsDir}`)
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2))
    Logger.info(`Evaluation results saved to: ${filePath}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

async function simulateAgentMessageFlow(
  evalItem: EvalData,
  userCtx: string,
): Promise<EvalResult> {
  const startTime = Date.now()

  const result: EvalResult = {
    input: evalItem.input,
    output: {
      answerType: "error",
      cost: 0,
    },
    expected: evalItem.expected,
    score: 0,
    metrics: {
      answerTypeMatch: false,
      citationMatch: false,
      hasAnswerMatch: false,
      titleMatch: false,
      queryRewriteMatch: false,
      errorMatch: false,
    },
    processingTime: 0,
  }

  try {
    let message = decodeURIComponent(evalItem.input)
    const costArr: number[] = []

    // Generate title for new chats
    Logger.info("Generating title for new chat...")
    const titleResp = await generateTitleUsingQuery(message, {
      modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
      stream: false,
    })
    result.output.title = titleResp.title
    if (titleResp.cost) costArr.push(titleResp.cost)
    Logger.info(`Generated title: ${result.output.title}`)

    // Check if message has context
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }

    const fileIds = extractedInfo?.fileIds || []
    const attachmentFileIds = evalItem.attachmentFileIds || []

    // Process based on context availability
    if (
      (isMsgWithContext && fileIds.length > 0) ||
      attachmentFileIds.length > 0
    ) {
      Logger.info("Processing message with context...")
      result.output.answerType = "context"

      const iterator = UnderstandMessageAndAnswerForGivenContext(
        myEmail,
        userCtx,
        message,
        0.5,
        fileIds,
        evalItem.isReasoningEnabled || false,
        undefined, // span
        [], // messages
        attachmentFileIds,
        hardcodedAgentPrompt,
      )

      let answer = ""
      let thinking = ""
      let citations: any[] = []
      let citationMap: Record<number, number> = {}

      for await (const chunk of iterator) {
        if (chunk.text) {
          if (evalItem.isReasoningEnabled && chunk.reasoning) {
            thinking += chunk.text
          } else if (!chunk.reasoning) {
            answer += chunk.text
          }
        }
        if (chunk.cost) {
          costArr.push(chunk.cost)
        }
        if (chunk.citation) {
          const { index, item } = chunk.citation
          citations.push(item)
          citationMap[index] = citations.length - 1
        }
      }

      result.output.answer = answer
      result.output.citations = citations
      result.output.reasoning = thinking
    } else {
      Logger.info("Processing message without specific context...")

      // Convert previous messages to conversation format
      const messagesWithNoErrResponse = (evalItem.previousMessages || []).map(
        (msg) => ({
          role: msg.messageRole,
          content: [{ text: msg.content }],
        }),
      )

      // Check if answer exists in conversation or needs query rewrite
      const formattedMessages: Message[] = messagesWithNoErrResponse
        .slice(-8)
        .map((msg) => ({
          role: msg.role as ConversationRole,
          content: msg.content.map((c) => ({
            type: "text",
            text: c.text,
          })),
        }))

      const searchOrAnswerIterator =
        generateSearchQueryOrAnswerFromConversation(message, userCtx, {
          modelId: hardcodedModelId,
          stream: true,
          json: true,
          reasoning: evalItem.isReasoningEnabled || false,
          messages: formattedMessages,
          agentPrompt: hardcodedAgentPrompt,
        })

      let buffer = ""
      let thinking = ""
      let reasoning = evalItem.isReasoningEnabled || false
      let parsed: any = {
        answer: "",
        queryRewrite: "",
        temporalDirection: null,
        filter_query: "",
        type: "",
        intent: {},
        filters: {},
      }

      for await (const chunk of searchOrAnswerIterator) {
        if (chunk.text) {
          if (reasoning && chunk.text.includes("</think>")) {
            reasoning = false
            const parts = chunk.text.split("</think>")
            if (parts[0]) thinking += parts[0]
            if (parts[1]) buffer += parts[1].trim()
          } else if (reasoning) {
            thinking += chunk.text
          } else {
            buffer += chunk.text
          }
        }
        if (chunk.cost) {
          costArr.push(chunk.cost)
        }
      }

      try {
        parsed = JSON.parse(buffer) || {}
      } catch (err) {
        Logger.error(`Failed to parse conversation analysis: ${buffer}`)
      }

      if (parsed.answer) {
        // Answer found in conversation
        result.output.answerType = "conversation"
        result.output.answer = parsed.answer
        result.output.reasoning = thinking
      } else {
        // Need to use RAG
        Logger.info("Using RAG pipeline...")
        result.output.answerType = "rag"
        result.output.queryRewrite = parsed.queryRewrite || undefined

        const rewrittenMessage = parsed.queryRewrite || message
        const classification = {
          direction: parsed.temporalDirection,
          type: parsed.type,
          filterQuery: parsed.filter_query,
          filters: parsed.filters || {},
        }

        const formattedMessage: Message[] = messagesWithNoErrResponse
          .slice(-8)
          .map((msg) => ({
            role: msg.role as ConversationRole,
            content: msg.content.map((c) => ({
              type: "text",
              text: c.text,
            })),
          }))

        const ragIterator = UnderstandMessageAndAnswer(
          myEmail,
          userCtx,
          rewrittenMessage,
          classification,
          formattedMessage,
          0.5,
          evalItem.isReasoningEnabled || false,
          undefined, // span
          hardcodedAgentPrompt,
        )

        let answer = ""
        let ragThinking = ""
        let citations: any[] = []
        let citationMap: Record<number, number> = {}

        for await (const chunk of ragIterator) {
          if (chunk.text) {
            if (evalItem.isReasoningEnabled && chunk.reasoning) {
              ragThinking += chunk.text
            } else if (!chunk.reasoning) {
              answer += chunk.text
            }
          }
          if (chunk.cost) {
            costArr.push(chunk.cost)
          }
          if (chunk.citation) {
            const { index, item } = chunk.citation
            citations.push(item)
            citationMap[index] = citations.length - 1
          }
        }

        result.output.answer = answer
        result.output.citations = citations
        result.output.reasoning = ragThinking
      }
    }

    result.output.cost = costArr.reduce((sum, cost) => sum + cost, 0)
  } catch (error) {
    Logger.error(`Error in agent message flow: ${error}`)
    result.output.error = (error as Error).message
    result.output.answerType = "error"
  }

  result.processingTime = Date.now() - startTime
  return result
}

async function runEvaluation(userCtx: string) {
  const results: EvalResult[] = []

  Logger.info("Starting Agent Message API evaluation...")
  Logger.info("User context:\n" + userCtx)

  for (const item of data) {
    Logger.info(`Processing query: "${item.input}"`)

    await sleep(2000) // Rate limiting

    const result = await simulateAgentMessageFlow(item, userCtx)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer type: ${result.output.answerType}`)
    Logger.info(`- Has answer: ${!!result.output.answer}`)
    Logger.info(`- Citations: ${result.output.citations?.length || 0}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)
    Logger.info(`- Cost: ${result.output.cost || 0}`)

    result.score = evaluateResponse(result)
    results.push(result)

    console.log("---")
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgProcessingTime =
    results.reduce((sum, r) => sum + r.processingTime, 0) / results.length
  const totalCost = results.reduce((sum, r) => sum + (r.output.cost || 0), 0)

  console.log(pc.green(`\n=== FINAL RESULTS ===`))
  console.log(`Average Score: ${(avgScore * 100).toFixed(1)}%`)
  console.log(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`)
  console.log(`Total Cost: ${totalCost.toFixed(4)}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "agent-message-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)

  return { avgScore, results, avgProcessingTime, totalCost }
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    )
    const ctx = userContext(userAndWorkspace)
    await runEvaluation(ctx)
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error)
    throw error
  }
}

await callRunEvaluation()