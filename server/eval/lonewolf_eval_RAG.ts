import pc from "picocolors"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { sleep } from "bun"
import { isCuid } from "@paralleldrive/cuid2"
import { HTTPException } from "hono/http-exception"
import config from "@/config"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { ChatSSEvents, } from "@/shared/types"
import type { ConversationRole } from "@aws-sdk/client-bedrock-runtime"

import {
  // baselineRAGIterationJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  jsonParseLLMOutput,
} from "@/ai/provider"


const { defaultBestModel} = config;
const myEmail = "email@domain.in"
const workspaceId = "i3ac.........." // This is the externalId of workspace
const agentId = "kekosrqyf78w1tlt90psfa4vc" // This is the externalId of the agent
const modelId = defaultBestModel
const Logger = getLogger(Subsystem.Eval)
const agentPromptForLLM = JSON.stringify({
  name: "DPIP Assistant",
  description: "An AI product manager assistant for the Digital Payments Intelligence Platform (DPIP)",
  prompt: `You are an AI assistant acting as the Product Manager for the Digital Payments Intelligence Platform (DPIP). Your role is to answer questions about DPIP with enthusiasm, professionalism, and expertise. You have access to a comprehensive knowledge base about DPIP, which is provided below:

<dpip_knowledge_base>
{{DPIP_KNOWLEDGE_BASE}}
</dpip_knowledge_base>

Here is the question you need to answer:

<question>
{{QUESTION}}
</question>

When presented with a question, you should draw upon this knowledge base to provide accurate and relevant answers. Your responses should showcase the value and importance of DPIP, highlighting its key features, benefits, and impact on the Indian financial ecosystem.

Instructions for answering:

1. Carefully read the question and identify the key points that need to be addressed.

2. Wrap your analysis inside <question_analysis> tags:
   a. Summarize the question in one sentence.
   b. List 3–5 key points from the knowledge base relevant to the question.
   c. Outline the structure of your response (use headings, bullet points, or numbered lists if appropriate).
   d. Determine if a Mermaid diagram would help explain any concepts. If so, draft the diagram.
   e. Highlight potential problems solved and benefits provided by DPIP related to the question.
   f. Identify and list any gaps in the knowledge base related to the question.
   g. Consider and note potential counterarguments or limitations of DPIP related to the question.

3. If you decided a Mermaid diagram would be helpful, include it in your analysis using the following format:
\`\`\`mermaid
[Your diagram code here]
\`\`\`

4. Compose your final answer within <answer> tags. Your response should:
   - Be accurate and based on the information in the knowledge base.
   - Present facts where available, without altering or embellishing.
   - Clearly state when specific information is not available rather than speculating.
   - Be clear, concise, yet comprehensive.
   - Maintain an enthusiastic and professional tone.
   - Highlight key features, benefits, or statistics.
   - Include the Mermaid diagram if you created one.
   - Address any identified gaps, counterarguments, or limitations if relevant.

5. Review your answer to ensure it addresses all aspects of the question and adheres to these guidelines.

Example output structure:

<question_analysis>
Question summary: [One-sentence summary of the question]

Relevant key points:
1. [Key point 1]
2. [Key point 2]
3. [Key point 3]

Response structure:
- [Main topic 1]
  - [Subtopic 1.1]
  - [Subtopic 1.2]
- [Main topic 2]
  - [Subtopic 2.1]
  - [Subtopic 2.2]

Mermaid diagram (if applicable):
\`\`\`mermaid
graph TD
    A[Example Node] --> B[Example Node 2]
    B --> C[Example Node 3]
\`\`\`

Problems solved and benefits:
- [Problem/Benefit 1]
- [Problem/Benefit 2]
- [Problem/Benefit 3]

Knowledge gaps:
- [Gap 1]
- [Gap 2]

Potential counterarguments or limitations:
- [Counterargument/Limitation 1]
- [Counterargument/Limitation 2]
</question_analysis>

<answer>
[Your structured, enthusiastic, and professional response to the question, incorporating the analysis and any relevant Mermaid diagrams]
</answer>

Remember to maintain a tone that is:
- Enthusiastic and passionate about DPIP
- Professional and knowledgeable
- Clear and concise, yet comprehensive

If you cannot answer a question based on the information in the knowledge base, clearly state that you don't have that specific information.

Please proceed with your response to the given question.`,
  appIntegrations: []
});


if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

type EvalData = {
  input: string
  expected: string
}

type EvalResult = {
  input: string
  expected: string
  output: string
  score: number
  processingTime: number
}

// Simple Levenshtein distance function for partial matching
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

// Calculate similarity score (0 to 1) based on Levenshtein distance
function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2
  const shorter = str1.length > str2.length ? str2 : str1
  if (longer.length === 0) return 1.0
  const distance = levenshteinDistance(longer, shorter)
  return (longer.length - distance) / longer.length
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
    return parsedData.map(item => ({
      input: item.input,
      expected: item.expected
    }))
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

function evaluateResponse(result: EvalResult): number {
  const { output, expected } = result

  console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########")
  console.log("Generated answer:", output)
  console.log("Expected answer:", expected)

  // Normalize strings for comparison
  const normalizedOutput = output.trim().toLowerCase()
  const normalizedExpected = expected.trim().toLowerCase()

  // Exact match check
  const isExactMatch = normalizedOutput === normalizedExpected

  // Partial match check using similarity score
  const similarityThreshold = 0.7 // 70% similarity for partial match
  const similarity = calculateSimilarity(normalizedOutput, normalizedExpected)
  const isPartialMatch = similarity >= similarityThreshold

  // Scoring: 1 for exact match, 0.5 for partial match, 0 for no match
  let score = 0
  if (isExactMatch) {
    score = 1
    console.log(pc.green("✅ Exact match"))
 } else if (isPartialMatch) {
    score = 0.5
    console.log(pc.yellow("⚠️ Partial match"))
    console.log(`Similarity score: ${(similarity * 100).toFixed(1)}%`)
  } else {
    console.log(pc.red("❌ No match"))
    console.log(`Similarity score: ${(similarity * 100).toFixed(1)}%`)
  }

  console.log(pc.green(`Score: ${(score * 100).toFixed(1)}%`))

  return score
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
    expected: evalItem.expected,
    output: "",
    score: 0,
    processingTime: 0,
  }

  Logger.info(`Simulating agent message flow for input: "${JSON.stringify(result)}"`)

  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      myEmail,
    )
    const { user, workspace } = userAndWorkspace

    Logger.info(`Simulating agent message flow for user: ${user.id}, workspace: ${workspace.id}`)

    const message = decodeURIComponent(evalItem.input)
    let answer = ""

    // Mock message context (simulating a single user message with no prior conversation)
    const messages = [
      {
        messageRole: MessageRole.User,
        message: message,
        fileIds: [],
      },
    ]

    // Process messages to filter out errors and empty assistant messages
    const messagesWithNoErrResponse = messages
      .filter((msg) => !msg?.errorMessage)
      .filter(
        (msg) =>
          !(msg.messageRole === MessageRole.Assistant && !msg.message),
      )
      .map((msg) => {
        const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
        let processedMessage = msg.message
        if (
          msg.messageRole === MessageRole.User &&
          fileIds &&
          fileIds.length > 0
        ) {
          // Simplified: assume no context selection for evaluation
          processedMessage = msg.message
        }
        return {
          role: msg.messageRole as ConversationRole,
          content: [{ text: processedMessage }],
        }
      })

    // Limit messages to last 8 (in this case, just the input message)
    const limitedMessages = messagesWithNoErrResponse.slice(-8)

    // Mock stream for SSE events
    const mockStream: any = {
      writeSSE: (event: { event: string; data: any }) => {
        if (event.event === ChatSSEvents.ResponseUpdate) {
          const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
          answer += data
        }
      },
      close: () => {},
      closed: false,
    }

    // Call LLM to generate answer
    Logger.info("Checking if answer is in the conversation or a mandatory query rewrite is needed")
    const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(message, userCtx, {
      modelId: modelId, // Placeholder; replace with actual model ID if needed
      stream: true,
      json: true,
      reasoning: false, // Simplified for evaluation
      messages: limitedMessages,
      agentPrompt: agentPromptForLLM,
    })

    let currentAnswer = ""
    let parsed = {
      answer: "",
      queryRewrite: "",
      temporalDirection: null,
      filter_query: "",
      type: "",
      intent: {},
      filters: {
        app: "",
        entity: "",
        startTime: "",
        endTime: "",
        count: 0,
        sortDirection: "",
      },
    }

    // Process LLM output
    let buffer = ""
    for await (const chunk of searchOrAnswerIterator) {
      if (mockStream.closed) {
        Logger.info("[simulateAgentMessageFlow] Stream closed during conversation search loop. Breaking.")
        break
      }
      if (chunk.text) {
        buffer += chunk.text
        try {
          parsed = jsonParseLLMOutput(buffer) || {}
          if (parsed.answer && currentAnswer !== parsed.answer) {
            if (currentAnswer === "") {
              Logger.info("Found answer in conversation, sending full response")
              mockStream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })
              mockStream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: parsed.answer,
              })
            } else {
              const newText = parsed.answer.slice(currentAnswer.length)
              mockStream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: newText,
              })
            }
            currentAnswer = parsed.answer
            Logger.info("Current answer updated:", currentAnswer)
          }
        } catch (err) {
          const errMessage = (err as Error).message
          Logger.error(`Error while parsing LLM output: ${errMessage}`)
          continue
        }
      }
    }

    result.output = parsed.answer || "No answer generated"

    console.log("Final answer:", result.output)
  } catch (error) {
    Logger.error(`Error in agent message flow: ${error}`)
    result.output = `Error: ${(error as Error).message}`
  }

  result.processingTime = Date.now() - startTime
  return result
}

async function runEvaluation(userCtx: string) {
  const results: EvalResult[] = []

  Logger.info("Starting Agent Message API evaluation...")
  Logger.info("User context:\n" + userCtx)

  for (const item of data) {
    Logger.info(`Processing query: "${JSON.stringify(item)}"`)// Rate limiting

    const result = await simulateAgentMessageFlow(item, userCtx)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer: ${result.output}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)

    result.score = evaluateResponse(result)
    results.push(result)

    console.log("---")
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgProcessingTime =
    results.reduce((sum, r) => sum + r.processingTime, 0) / results.length

  console.log(pc.green(`\n=== FINAL RESULTS ===`))
  console.log(`Average Score: ${(avgScore * 100).toFixed(1)}%`)
  console.log(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "agent-message-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)

  return { avgScore, results, avgProcessingTime }
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