import pc from "picocolors"
import fs from "fs"
import path from "path"
import { answerContextMap, answerContextMapFromFragments, userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { sleep } from "bun"
import { isCuid } from "@paralleldrive/cuid2"
import { HTTPException } from "hono/http-exception"
import config from "@/config"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { Apps, ChatSSEvents } from "@/shared/types"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"

import {
    baselineRAGOffJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  getProviderByModel,
  jsonParseLLMOutput,
} from "@/ai/provider"
import { processMessage, searchToCitation } from "@/api/chat/utils"
import {
  type TemporalClassifier,
  type QueryRouterResponse,
  type QueryType,
  Models,
  type ModelParams,
  type LLMProvider,
} from "@/ai/types"
import { UnderstandMessageAndAnswer } from "@/api/chat/chat"
import { OpenAIProvider } from "@/ai/provider/openai"
import OpenAI from "openai"
import { getAllDocumentsForAgent, GetDocumentsByDocIds } from "@/search/vespa"
import type { VespaSearchResult, VespaSearchResultsSchema } from "@/search/types"
import type { z } from "zod"
import { getTracer, type Tracer } from "@/tracer"

const { defaultBestModel, maxDefaultSummary } = config
const myEmail = "oindrila.banerjee@juspay.in"
const workspaceId = "i3acjjlykgjyamw51qbwhhiu" // This is the externalId of workspace
const agentId = "kekosrqyf78w1tlt90psfa4v" // This is the externalId of the agent
const modelId = defaultBestModel
const Logger = getLogger(Subsystem.Eval)
let agentPromptForLLM = JSON.stringify({
  name: "DPIP Assistant",
  description:
    "An AI product manager assistant for the Digital Payments Intelligence Platform (DPIP)",
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
  appIntegrations: [],
})

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

const evaluateSystemPrompt = (
  input: string,
  expected: string,
  output: string,
) =>
  `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
  [BEGIN DATA]
  ************
  [Question]: ${input}
  ************
  [Expert]: ${expected}
  ************
  [Submission]: ${output}
  ************
  [END DATA]
  
  Compare the factual content of the submitted answer with the expert answer, ignoring differences in style, grammar, or punctuation. The submitted answer may be a subset, superset, or identical to the expert answer, or it may conflict with it. Consider the following:
  - A **subset** includes some but not all key facts from the expert answer, with no contradictions.
  - A **superset** includes all key facts from the expert answer plus additional consistent details.
  - **Identical** means the answers contain the same key facts.
  - A **disagreement** occurs only if the submitted answer contains facts that directly contradict the expert answer.
  - **Non-factual differences** include stylistic or irrelevant details that don’t affect accuracy.
  
  Select one of the following options:
  (A) The submitted answer is a subset of the expert answer and is fully consistent with it.
  (B) The submitted answer is a superset of the expert answer, including all its key facts plus additional consistent details.
  (C) The submitted answer contains all the same key facts as the expert answer.
  (D) There is a factual disagreement between the submitted answer and the expert answer.
  (E) The answers differ, but these differences don’t matter from the perspective of factuality.
  
  RESPOND WITH ONLY THE LETTER (A, B, C, D, or E) that best describes the relationship between the answers.`
  
const FactualityScorer = async (
  params: ModelParams,
  args: { input: string; expected: string; output: string },
) => {
  const openAiKey = process.env.OPENAI_API_KEY
  let provider: LLMProvider | null = null

  if (!openAiKey) {
    if (!params.modelId) params.modelId = modelId
    provider = getProviderByModel(params.modelId)
    Logger.info(
      "OpenAI key not found for evaluation, going with bedrock models",
    )
  } else {
    provider = new OpenAIProvider(new OpenAI({ apiKey: openAiKey }))
    Logger.info("Evaluating with openai")
    params.modelId = Models.Gpt_4o_mini
  }

  params.systemPrompt = evaluateSystemPrompt(
    args.input,
    args.expected,
    args.output,
  )
  Logger.info("System prompt sent to LLM:", params.systemPrompt); // Add logging

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: "now evaluate the system prompt, just respond with the letters",
      },
    ],
  }

  const { text, cost } = await provider.converse([baseMessage], params)

  Logger.info("LLM response received:", text); // Add logging
  return { text, cost }
}

  
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
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
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
    return parsedData.map((item) => ({
      input: item.input,
      expected: item.expected,
    }))
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

async function evaluateResponse(result: EvalResult): Promise<number> {
  const { input, output, expected } = result;

  console.log("\n=== CUSTOM LLM FACTUALITY EVALUATION ===");
  console.log("Input:", input);
  console.log("Generated answer:", output);
  console.log("Expected answer:", expected);

  try {
    // Call hypothetical LLM-based FactualityScorer
    const response = await FactualityScorer(
      { modelId: modelId, stream: false },
      { input, output, expected }
    );

    console.log("Raw LLM response:", response);

    // Extract the choice from the response
    const content = (response.text && response.text.trim()) || "";
    
    // Map the choice to a score (in percentage)
    const choiceScores: Record<string, number> = {
      A: 40,  // Mostly incorrect
      B: 60,  // Partially correct
      C: 100, // Fully correct
      D: 0,   // Completely incorrect
      E: 100, // Fully correct with additional detail
    };

    let score = 0; // Default score (0.5 * 100)
    if (content in choiceScores) {
      score = choiceScores[content];
    } else {
      console.log("Invalid choice received, using default score 0%");
    }

    console.log(`Final factuality score: ${score.toFixed(1)}%`);
    return score;
  } catch (error: any) {
    console.error("Factuality Scorer API error:", error.message);
    console.log("Using default score 0% due to error");
    return 0;
  }
}

function saveEvalResults(
  evaluation: { averageScore: number; results: EvalResult[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${name}-${timestamp}.json`;
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
    fileName,
  );

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
  );
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true });
    Logger.info(`Created directory: ${evalResultsDir}`);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2));
    Logger.info(`Evaluation results saved to: ${filePath}`);
    return fileName;
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`);
    throw error;
  }
}

// Add evaluation scoring function
function calculateSimilarityScore(expected: string, actual: string): number {
  // Normalize strings - remove extra whitespace, convert to lowercase
  const normalizeText = (text: string): string => {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
  };
  
  const normalizedExpected = normalizeText(expected);
  const normalizedActual = normalizeText(actual);
  
  // Exact match
  if (normalizedExpected === normalizedActual) {
    return 1.0;
  }
  
  // Jaccard similarity for word-based comparison
  const getWords = (text: string): Set<string> => new Set(text.split(' '));
  const expectedWords = getWords(normalizedExpected);
  const actualWords = getWords(normalizedActual);
  
  const intersection = new Set([...expectedWords].filter(x => actualWords.has(x)));
  const union = new Set([...expectedWords, ...actualWords]);
  
  const jaccardScore = intersection.size / union.size;
  
  // Substring containment bonus
  const containsExpected = normalizedActual.includes(normalizedExpected);
  const containsActual = normalizedExpected.includes(normalizedActual);
  
  if (containsExpected || containsActual) {
    return Math.max(jaccardScore, 0.8);
  }
  
  return jaccardScore;
}

// Improved deduplication function
function deduplicateText(text: string): string {
  // Remove consecutive duplicate sentences/phrases
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  const uniqueSentences = [];
  const seen = new Set();
  
  for (const sentence of sentences) {
    const normalized = sentence.trim().toLowerCase();
    if (!seen.has(normalized) && normalized.length > 0) {
      seen.add(normalized);
      uniqueSentences.push(sentence.trim());
    }
  }
  
  return uniqueSentences.join('. ').trim();
}

// Enhanced chunk processing
function processStreamChunks(chunks: string[]): string {
  // Join all chunks
  let fullText = chunks.join('');
  
  // Remove duplicate consecutive characters/words
  fullText = fullText.replace(/(.)\1{2,}/g, '$1'); // Remove 3+ consecutive chars
  
  // Deduplicate text
  fullText = deduplicateText(fullText);
  
  // Clean up formatting
  fullText = fullText
    .replace(/\s+/g, ' ') // Multiple spaces to single space
    .replace(/\n+/g, '\n') // Multiple newlines to single newline
    .trim();
  
  return fullText;
}

// Helper function to extract answer from various response formats
function extractAnswerFromResponse(response: string): string {
  // Remove analysis and planning tags first
  let cleanedResponse = response;
  cleanedResponse = cleanedResponse.replace(/<analysis_and_planning>[\s\S]*?<\/analysis_and_planning>/g, '');
  cleanedResponse = cleanedResponse.replace(/<question_analysis>[\s\S]*?<\/question_analysis>/g, '');
  
  // Try to extract JSON from markdown code blocks
  const jsonCodeBlockMatch = cleanedResponse.match(/```json\s*([\s\S]*?)```/);
  if (jsonCodeBlockMatch && jsonCodeBlockMatch[1]) {
    try {
      const jsonStr = jsonCodeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      
      // Extract answer field if it exists
      if (parsed.answer) {
        return parsed.answer;
      }
    } catch (err) {
      // Not valid JSON, continue
    }
  }
  
  // Try to parse as plain JSON
  try {
    // Check if the response contains JSON
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      
      // Extract answer field if it exists
      if (parsed.answer) {
        return parsed.answer;
      }
    }
  } catch (err) {
    // Not valid JSON, continue with other extraction methods
  }

  // Try to extract content between <answer> tags
  const answerTagMatch = cleanedResponse.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerTagMatch && answerTagMatch[1]) {
    return answerTagMatch[1].trim();
  }

  // Try to extract content after "Final answer:" or similar patterns
  const finalAnswerMatch = cleanedResponse.match(/Final answer:\s*([\s\S]*?)(?:Expected:|Similarity Score:|$)/i);
  if (finalAnswerMatch && finalAnswerMatch[1]) {
    return finalAnswerMatch[1].trim();
  }
  
  // If the response starts with markdown headers or formatting, return as is
  if (cleanedResponse.match(/^#{1,6}\s/m) || cleanedResponse.includes('##')) {
    return cleanedResponse.trim();
  }
  
  // If no specific format found, return the cleaned response
  return cleanedResponse.trim();
}

async function simulateAgentMessageFlowWithRagOff(
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

  Logger.info(
    `Simulating agent message flow for input: "${JSON.stringify(result)}"`,
  )

  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    )
    const { user, workspace } = userAndWorkspace

    Logger.info(
      `Simulating agent message flow for user: ${user.id}, workspace: ${workspace.id}`,
    )

    if (agentId && isCuid(agentId)) {
      const agentForDb = await getAgentByExternalIdWithPermissionCheck(
        db,
        agentId,
        workspace.id,
        user.id,
      )
      if (!agentForDb) {
        throw new HTTPException(403, {
          message: "Access denied: You don't have permission to use this agent",
        })
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
    }

    const message = decodeURIComponent(evalItem.input)
    let finalAnswer = ""
    let thinking = ""

    // Create message context
    const messages = [
      {
        messageRole: MessageRole.User,
        message: message,
        fileIds: [],
      },
    ]

       const allDataSources = await getAllDocumentsForAgent(myEmail, [
              Apps.DataSource,
            ])
            
            let docIds: string[] = []
            if (allDataSources && allDataSources.root && allDataSources.root.children) {
              docIds = [
                ...new Set(
                  allDataSources.root.children
                    .map(
                      (child: VespaSearchResult) =>
                        (child.fields as any)?.docId as string,
                    )
                    .filter(Boolean),
                ),
              ]
            }
             const tracer: Tracer = getTracer("chat")
             const rootSpan = tracer.startSpan("AgentMessageApiRagOff")
            let context = ""
            if (docIds.length > 0) {
              const allChunks = await GetDocumentsByDocIds(docIds,rootSpan)
              if (allChunks?.root?.children) {
                context = answerContextMapFromFragments(
                  allChunks.root.children.map((child: VespaSearchResult) => ({
                    id: `${(child.fields as any)?.docId || "Frangment_id_"}`,
                    content: answerContextMap(
                      child as z.infer<typeof VespaSearchResultsSchema>,
                      0,
                      true,
                    ),
                    source: searchToCitation(
                      child as z.infer<typeof VespaSearchResultsSchema>,
                    ),
                    confidence: 1.0,
                  })),
                  maxDefaultSummary,
                )
              }
            }
            
    // Process messages
    const messagesWithNoErrResponse = messages
      .filter((msg: any) => !msg?.errorMessage)
      .filter(
        (msg) => !(msg.messageRole === MessageRole.Assistant && !msg.message),
      )
      .map((msg) => {
        const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
        let processedMessage = msg.message
        if (
          msg.messageRole === MessageRole.User &&
          fileIds &&
          fileIds.length > 0
        ) {
          processedMessage = msg.message
        }
        return {
          role: msg.messageRole as ConversationRole,
          content: [{ text: processedMessage }],
        }
      })

    const limitedMessages = messagesWithNoErrResponse.slice(-8)

    // Enhanced mock stream with better chunk handling
    const mockStream: any = {
      writeSSE: (event: { event: string; data: any }) => {
        if (event.event === ChatSSEvents.Reasoning) {
          thinking += event.data
        }
      },
      close: () => {},
      closed: false,
    }

    Logger.info(
      "Checking if answer is in the conversation or a mandatory query rewrite is needed",
    )
    
        const ragOffIterator = baselineRAGOffJsonStream(
          message,
          userCtx,
          context,
          {
            modelId: defaultBestModel,
            stream: true,
            json: false,
            reasoning: false,
            messages: messagesWithNoErrResponse,
          },
          agentPromptForLLM ?? "",
          messages.map((m) => ({
            role: m.messageRole as ConversationRole,
            content: [{ text: m.message }],
          })),
          [],
        )

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

    // Process LLM output with better error handling
    let buffer = ""
    const answerChunks: string[] = []
    
    for await (const chunk of ragOffIterator) {
      if (mockStream.closed) {
        Logger.info(
          "[simulateAgentMessageFlow] Stream closed during conversation search loop. Breaking.",
        )
        break
      }
      
      if (chunk.text) {
        buffer += chunk.text
        answerChunks.push(chunk.text)
        
        try {
          // Only parse if buffer looks like complete JSON
          if (buffer.trim().startsWith('{') && buffer.trim().endsWith('}')) {
            parsed = jsonParseLLMOutput(buffer) || parsed
          }
        } catch (err) {
          const errMessage = (err as Error).message
          Logger.error(`Error while parsing LLM output: ${errMessage}`)
          continue
        }
      }
    }

    // Process the collected chunks - use the full buffer instead
    const processedChunks = buffer

    // If answer was found in conversation, use it directly
    if (parsed.answer) {
      // Extract clean answer from parsed response
      finalAnswer = extractAnswerFromResponse(parsed.answer)
      Logger.info("Found answer in conversation:", finalAnswer)
    } else {
      // If no answer was found, use UnderstandMessageAndAnswer
      Logger.info(
        "No answer found in conversation, applying UnderstandMessageAndAnswer",
      )

      const classification: TemporalClassifier & QueryRouterResponse = {
        direction: parsed.temporalDirection,
        type: parsed.type as QueryType,
        filterQuery: parsed.filter_query,
        filters: {
          ...(parsed?.filters ?? {}),
          app: parsed.filters?.app as Apps,
          entity: parsed.filters?.entity as any,
          intent: parsed.intent || {},
        },
      }

      const iterator = UnderstandMessageAndAnswer(
        myEmail,
        userCtx,
        parsed.queryRewrite || message,
        classification,
        limitedMessages,
        0.5,
        false,
        undefined,
        agentPromptForLLM,
      )

      let understandAnswerChunks: string[] = []

      for await (const chunk of iterator) {
        if (mockStream.closed) {
          Logger.info(
            "[simulateAgentMessageFlow] Stream closed during UnderstandMessageAndAnswer loop. Breaking.",
          )
          break
        }
        if (chunk.text) {
          understandAnswerChunks.push(chunk.text)
        }
      }

      // Process the understand answer chunks
      const rawAnswer = processStreamChunks(understandAnswerChunks)
      // Extract clean answer from the response
      finalAnswer = extractAnswerFromResponse(rawAnswer)
      Logger.info("Answer from UnderstandMessageAndAnswer:", finalAnswer)
    }

    // Set the final output - ensure it's clean
    result.output = finalAnswer || "No answer generated"

    // Calculate factuality score
    if (result.output && result.expected) {
      result.score = await evaluateResponse(result)
    }

    Logger.info(`Evaluation completed. Score: ${result.score}`)
    console.log("Final answer:", result.output)
    console.log("Expected:", result.expected)
    console.log("Factuality Score:", result.score)

  } catch (error) {
    Logger.error(`Error in agent message flow: ${error}`)
    result.output = `Error: ${(error as Error).message}`
    result.score = 0
  }

  result.processingTime = Date.now() - startTime
  return result
}

// Additional helper function for batch evaluation
async function evaluateAgentPerformance(
  evalItems: EvalData[],
  userCtx: string,
): Promise<{
  averageScore: number;
  results: EvalResult[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    averageProcessingTime: number;
  };
}> {
  const results: EvalResult[] = []
  
  for (const item of evalItems) {
    const result = await simulateAgentMessageFlowWithRagOff(item, userCtx)
    results.push(result)
  }
  
  const totalScore = results.reduce((sum, r) => sum + r.score, 0)
  const averageScore = totalScore / results.length
  const averageProcessingTime = results.reduce((sum, r) => sum + r.processingTime, 0) / results.length
  
  const passed = results.filter(r => r.score > 70).length // Threshold for "passing" adjusted to percentage
  const failed = results.length - passed
  
  return {
    averageScore,
    results,
    summary: {
      totalTests: results.length,
      passed,
      failed,
      averageProcessingTime,
    },
  }
}

async function runEvaluation(userCtx: string) {
  const results: EvalResult[] = []

  Logger.info("Starting Agent Message API evaluation...")
  Logger.info("User context:\n" + userCtx)

  for (const item of data) {
    Logger.info(`Processing query: "${JSON.stringify(item)}"`) // Rate limiting

    const result = await simulateAgentMessageFlowWithRagOff(item, userCtx)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer: ${result.output}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)

    result.score = await evaluateResponse(result)
    results.push(result)

    console.log("---")
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgProcessingTime =
    results.reduce((sum, r) => sum + r.processingTime, 0) / results.length

  console.log(pc.green(`\n=== FINAL RESULTS ===`))
  console.log(`Average Score: ${(avgScore).toFixed(1)}%`)
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