import pc from "picocolors"
import fs from "fs"
import path from "path"
import {
  answerContextMap,
  answerContextMapFromFragments,
  userContext,
} from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { sleep } from "bun"
import { isCuid } from "@paralleldrive/cuid2"
import { HTTPException } from "hono/http-exception"
import config from "@/config"
import {
  getAgentByExternalId,
  getIntegrationConfigurationsByWorkspace,
  type SelectAgent,
} from "@/db/agent"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import { extractImageFileNames, searchToCitation } from "@/api/chat/utils"
import { type ModelParams } from "@/ai/types"
import { GetKbFilesByKbIds } from "@/search/vespa"
import type {
  VespaSearchResult,
  VespaSearchResultsSchema,
} from "@/search/types"
import type { z } from "zod"
import { getTracer, type Tracer } from "@/tracer"
import { VertexAI } from "@google-cloud/vertexai"
import type { MinimalAgentFragment } from "@/api/chat/types"
import {
  nonRagIterator,
  vespaResultToMinimalAgentFragment,
} from "@/api/chat/agents"
import { dpipFormParams, dpipJourneyPrompt } from "@/ai/dpipprompt"

const { defaultBestModel, defaultFastModel, VertexProjectId, VertexRegion } =
  config
const myEmail = "oindrila@rbi.in"
const workspaceId = "rddl9wm8ds0p09uhddoo61pl"
const agentId = "i5bauhvg5p5e136fwkanq870"
const modelId = defaultBestModel
const Logger = getLogger(Subsystem.Eval)
let context = ""

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

// RETRY UTILITY FUNCTION
interface RetryOptions {
  maxRetries?: number
  delayMs?: number
  retryCondition?: (error: any) => boolean
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    delayMs = 10000,
    retryCondition = (error: any) => {
      const errorMessage = error?.message?.toLowerCase() || ""
      const statusCode = error?.status || error?.statusCode || error?.code

      return (
        statusCode === 403 ||
        statusCode === 429 ||
        statusCode === 500 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504 ||
        errorMessage.includes("403") ||
        errorMessage.includes("forbidden") ||
        errorMessage.includes("rate limit") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("network") ||
        errorMessage.includes("connection")
      )
    },
  } = options

  let lastError: any

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (attempt === maxRetries || !retryCondition(error)) {
        throw error
      }

      await sleep(delayMs)
    }
  }

  throw lastError
}

// FACTUALITY SCORER IMPLEMENTATION
const evaluateSystemPrompt = (
  input: string,
  expected: string,
  output: string,
  context: string,
) =>
  `SYSTEM
You are an expert evaluator for enterprise documentation Q&A systems. 
Evaluate TWO answers independently using ONLY the provided Knowledge Base (KB) as ground truth.
Be deterministic, thorough, and provide detailed reasoning.

# KB (Knowledge Base)
${context}

# QUESTION
${input}

# ANSWER_GENERATED
${output}

# ANSWER_GROUND (Ground Truth)
${expected}

## EVALUATION FRAMEWORK

### Primary Labels (per answer)
- DOC_SUPPORTED: Answer clearly present in or tightly implied by KB
- DOMAIN_OK: On-topic background that helps, WITHOUT invented specifics not in KB (requires disclaimer)
- OFF_SCOPE: Not about the domain or asked task
- HALLUCINATION: Contains invented specifics not in KB

### Scoring Dimensions (0.0-5.0 scale)
1. **DomainRelevance**: Topical focus on the subject matter
2. **Factuality**: Correctness based on KB and expected answer
3. **SemanticSimilarity**: Meaning alignment with ground truth
4. **Completeness**: Coverage of all question components
5. **InventedSpecificsScore (ISS)**: Penalty for content not in KB (lower=better), clip at 5.0
  - url/host=0.25, port=0.20, api/path=0.20, version=0.20, code=0.25, id/error=0.20, numeric-claim=0.15

### Additional Metrics
- **Contradiction**: yes|no (conflicts with KB or ground truth?)
- **DisclaimerPresent**: yes|no|n/a (required for DOMAIN_OK)
- **InventedSpecificsTypes**: [url,port,path,version,code,id,number]

## EVALUATION RULES
1. KB is source of truth; if KB conflicts with general knowledge, prefer KB
2. DOMAIN_OK allowed only if no invented specifics and clearly relevant
3. Background beyond KB requires disclaimer (e.g., "General note: ...")
4. Any specific not in KB contributes to ISS; severe cases → HALLUCINATION
5. Compare semantic meaning, not just surface text
6. Assign OVERALL -1 for direct contradiction with demonstrably false information

## SCORING GUIDELINES
- 4.5-5.0: Excellent - Meets/exceeds expectations
- 3.5-4.4: Good - Solid with minor issues  
- 2.5-3.4: Adequate - Acceptable with notable gaps
- 1.5-2.4: Poor - Significant deficiencies
- 0.0-1.4: Very Poor - Major problems
- -1: Critical failure with false contradictions

## RETURN FORMAT

BEGIN-REPORT

ANSWER_ID: GENERATED
DETAILED_ANALYSIS:
[Systematic evaluation with specific examples and reasoning]

LABEL: DOC_SUPPORTED | DOMAIN_OK | OFF_SCOPE | HALLUCINATION
DomainRelevance: <0.0-5.0>
Factuality: <0.0-5.0>
SemanticSimilarity: <0.0-5.0>
Completeness: <0.0-5.0>
ISS: <0.0-5.0>
Contradiction: yes|no
DisclaimerPresent: yes|no|n/a
InventedSpecificsTypes: [comma-separated types]
Notes: <concise reasoning ≤15 words>

ANSWER_ID: GROUND
DETAILED_ANALYSIS:
[Systematic evaluation with specific examples and reasoning]

LABEL: DOC_SUPPORTED | DOMAIN_OK | OFF_SCOPE | HALLUCINATION
DomainRelevance: <0.0-5.0>
Factuality: <0.0-5.0>
SemanticSimilarity: <0.0-5.0>
Completeness: <0.0-5.0>
ISS: <0.0-5.0>
Contradiction: yes|no
DisclaimerPresent: yes|no|n/a
InventedSpecificsTypes: [comma-separated types]
Notes: <concise reasoning ≤15 words>

COMPARISON:
BetterAnswer: GENERATED | GROUND | TIE
BetterReason: <detailed justification>

THINKING:
[Provide detailed reasoning, comparing key facts, identifying correct/incorrect/missing elements, and explaining scoring rationale]

CONCLUSION:
[Brief summary of assessment]

END-OF-REPORT`

interface FactualityScorerArgs {
  input: string
  expected: string
  output: string
  context: string
}

interface FactualityScorerResponse {
  score: string
  thinking: string
  conclusion: string
  cost: number
  detailedAnalysis: string
  overallScore: string
  calculation: string
  generatedLabel: string
  generatedDomainRelevance: number
  generatedFactuality: number
  generatedSemanticSimilarity: number
  generatedCompleteness: number
  generatedISS: number
  generatedContradiction: string
  generatedDisclaimerPresent: string
  generatedInventedSpecificsTypes: string[]
  generatedNotes: string
  groundLabel: string
  groundDomainRelevance: number
  groundFactuality: number
  groundSemanticSimilarity: number
  groundCompleteness: number
  groundISS: number
  groundContradiction: string
  groundDisclaimerPresent: string
  groundInventedSpecificsTypes: string[]
  groundNotes: string
  betterAnswer: string
  betterReason: string
  overallScoreGenerated: number
  overallScoreGround: number
}

const FactualityScorer = async (
  params: ModelParams,
  args: FactualityScorerArgs,
): Promise<FactualityScorerResponse> => {
  const modelId = defaultFastModel || "gemini-2.5-pro"

  const operation = async () => {
    try {
      const vertexAI = new VertexAI({
        project: VertexProjectId,
        location: VertexRegion,
      })

      const model = vertexAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          maxOutputTokens: 20000,
          temperature: 0.0,
          topP: 1.0,
          topK: 1,
        },
      })

      Logger.info(`Using Factuality Scorer with model: ${modelId}`)
      const evaluationPrompt = evaluateSystemPrompt(
        args.input,
        args.expected,
        args.output,
        args.context,
      )

      const contents = [
        {
          role: "user",
          parts: [{ text: evaluationPrompt }],
        },
      ]

      const response = await model.generateContent({ contents })
      Logger.info(
        `Raw Vertex AI response text: ${response.response.candidates?.[0]?.content?.parts?.[0]?.text || "No text received"}`,
      )

      let text = ""
      const candidate = response.response.candidates?.[0]

      if (!candidate) {
        Logger.warn("No response received from Vertex AI model")
        return {
          score: "20",
          thinking: "No response received from model",
          conclusion: "Default score assigned",
          cost: 0,
          detailedAnalysis:
            "No response received from Vertex AI model, unable to evaluate dimensions.",
          overallScore: "20",
          calculation: "N/A (No response)",
          generatedLabel: "UNKNOWN",
          generatedDomainRelevance: 0,
          generatedFactuality: 0,
          generatedSemanticSimilarity: 0,
          generatedCompleteness: 0,
          generatedISS: 0,
          generatedContradiction: "no",
          generatedDisclaimerPresent: "n/a",
          generatedInventedSpecificsTypes: [],
          generatedNotes: "No response received",
          groundLabel: "UNKNOWN",
          groundDomainRelevance: 0,
          groundFactuality: 0,
          groundSemanticSimilarity: 0,
          groundCompleteness: 0,
          groundISS: 0,
          groundContradiction: "no",
          groundDisclaimerPresent: "n/a",
          groundInventedSpecificsTypes: [],
          groundNotes: "No response received",
          betterAnswer: "TIE",
          betterReason: "No response received",
          overallScoreGenerated: 20,
          overallScoreGround: 20,
        }
      }

      if (candidate.content?.parts?.[0]?.text) {
        text = candidate.content.parts[0].text.trim()
      } else if (candidate.content?.parts?.length > 0) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            text = part.text.trim()
            break
          }
        }
      }

      // Parse the evaluation response according to RETURN FORMAT
      let thinking = ""
      let conclusion = ""
      let extractedScore = ""
      let detailedAnalysis = ""
      let overallScore = ""
      let calculation = ""

      // Helper function to parse evaluation sections
      const parseEvaluationSection = (
        text: string,
        answerId: "GENERATED" | "GROUND",
      ) => {
        const sectionRegex = new RegExp(
          `ANSWER_ID: ${answerId}[\\s\\S]*?(?=ANSWER_ID:|COMPARISON:|$)`,
        )
        const sectionMatch = text.match(sectionRegex)
        const sectionText = sectionMatch ? sectionMatch[0] : ""

        return {
          detailedAnalysis: (
            sectionText.match(
              /DETAILED_ANALYSIS:([\s\S]*?)(?=LABEL:|$)/i,
            )?.[1] || ""
          ).trim(),
          label:
            sectionText.match(
              /LABEL:\s*(DOC_SUPPORTED|DOMAIN_OK|OFF_SCOPE|HALLUCINATION)/i,
            )?.[1] || "UNKNOWN",
          domainRelevance: parseFloat(
            sectionText.match(/DomainRelevance:\s*([0-9.]+)/i)?.[1] || "0",
          ),
          factuality: parseFloat(
            sectionText.match(/Factuality:\s*([0-9.]+)/i)?.[1] || "0",
          ),
          semanticSimilarity: parseFloat(
            sectionText.match(/SemanticSimilarity:\s*([0-9.]+)/i)?.[1] || "0",
          ),
          completeness: parseFloat(
            sectionText.match(/Completeness:\s*([0-9.]+)/i)?.[1] || "0",
          ),
          iss: parseFloat(sectionText.match(/ISS:\s*([0-9.]+)/i)?.[1] || "0"),
          contradiction:
            sectionText.match(/Contradiction:\s*(yes|no)/i)?.[1] || "no",
          disclaimerPresent:
            sectionText.match(/DisclaimerPresent:\s*(yes|no|n\/a)/i)?.[1] ||
            "n/a",
          inventedSpecificsTypes: (
            sectionText.match(/InventedSpecificsTypes:\s*\[(.*?)\]/i)?.[1] || ""
          )
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s),
          notes: (sectionText.match(/Notes:\s*(.*?)$/im)?.[1] || "").trim(),
        }
      }

      // Parse generated and ground truth evaluations
      const generatedEval = parseEvaluationSection(text, "GENERATED")
      const groundEval = parseEvaluationSection(text, "GROUND")

      // Parse comparison section
      const comparisonMatch = text.match(/COMPARISON:[\s\S]*?(?=THINKING:|$)/i)
      const comparisonText = comparisonMatch ? comparisonMatch[0] : ""
      const betterAnswer =
        comparisonText.match(/BetterAnswer:\s*(GENERATED|GROUND|TIE)/i)?.[1] ||
        "TIE"
      const betterReason =
        comparisonText
          .match(/BetterReason:\s*(.*?)(?=THINKING:|$)/im)?.[1]
          ?.trim() || "No comparison reason provided"

      // Parse thinking section
      const thinkingMatch = text.match(/THINKING:[\s\S]*?(?=CONCLUSION:|$)/i)
      if (thinkingMatch) {
        thinking = thinkingMatch[0].replace(/THINKING:/i, "").trim()
      } else {
        thinking =
          "No thinking provided. Generated answer evaluated based on dimension scores."
      }

      // Parse conclusion section
      const conclusionMatch = text.match(
        /CONCLUSION:[\s\S]*?(?=END-OF-REPORT|$)/i,
      )
      if (conclusionMatch) {
        conclusion = conclusionMatch[0].replace(/CONCLUSION:/i, "").trim()
      } else {
        conclusion =
          "Evaluation completed based on dimension scores and comparison."
      }

      // Combine detailed analysis
      detailedAnalysis = `Generated Answer Analysis:\n${generatedEval.detailedAnalysis}\n\nGround Truth Analysis:\n${groundEval.detailedAnalysis}`

      // Calculate overall scores
      const overallScoreGenerated = Math.round(
        (generatedEval.domainRelevance * 0.25 +
          generatedEval.factuality * 0.35 +
          generatedEval.semanticSimilarity * 0.25 +
          generatedEval.completeness * 0.15 -
          generatedEval.iss * 0.1) *
          20,
      )
      const overallScoreGround = Math.round(
        (groundEval.domainRelevance * 0.25 +
          groundEval.factuality * 0.35 +
          groundEval.semanticSimilarity * 0.25 +
          groundEval.completeness * 0.15 -
          groundEval.iss * 0.1) *
          20,
      )

      // Parse overall score
      extractedScore = overallScoreGenerated.toString()
      overallScore = extractedScore

      // Validate scores
      if (
        [
          generatedEval.domainRelevance,
          generatedEval.factuality,
          generatedEval.semanticSimilarity,
          generatedEval.completeness,
          generatedEval.iss,
          groundEval.domainRelevance,
          groundEval.factuality,
          groundEval.semanticSimilarity,
          groundEval.completeness,
          groundEval.iss,
        ].some((score) => score < 0 || score > 5)
      ) {
        Logger.warn("Invalid dimension score detected")
        return {
          score: "20",
          thinking: "Invalid dimension score in evaluation",
          conclusion: "Default score assigned due to invalid scores",
          cost: response.response.usageMetadata?.totalTokenCount || 0,
          detailedAnalysis: `Invalid dimension score detected in evaluation response.\n${detailedAnalysis}`,
          overallScore: "20",
          calculation: "N/A (Invalid scores)",
          generatedLabel: "UNKNOWN",
          generatedDomainRelevance: 0,
          generatedFactuality: 0,
          generatedSemanticSimilarity: 0,
          generatedCompleteness: 0,
          generatedISS: 0,
          generatedContradiction: "no",
          generatedDisclaimerPresent: "n/a",
          generatedInventedSpecificsTypes: [],
          generatedNotes: "Invalid scores detected",
          groundLabel: "UNKNOWN",
          groundDomainRelevance: 0,
          groundFactuality: 0,
          groundSemanticSimilarity: 0,
          groundCompleteness: 0,
          groundISS: 0,
          groundContradiction: "no",
          groundDisclaimerPresent: "n/a",
          groundInventedSpecificsTypes: [],
          groundNotes: "Invalid scores detected",
          betterAnswer: "TIE",
          betterReason: "Invalid scores detected",
          overallScoreGenerated: 20,
          overallScoreGround: 20,
        }
      }

      Logger.info(`Extracted evaluation score: ${extractedScore}`)
      Logger.info(`Evaluation thinking: ${thinking}`)
      Logger.info(`Detailed analysis: ${detailedAnalysis}`)

      return {
        score: extractedScore,
        thinking,
        conclusion,
        cost: response.response.usageMetadata?.totalTokenCount || 0,
        detailedAnalysis,
        overallScore,
        calculation: `Generated: ${overallScoreGenerated.toFixed(2)}, Ground: ${overallScoreGround.toFixed(2)}`,
        generatedLabel: generatedEval.label,
        generatedDomainRelevance: generatedEval.domainRelevance,
        generatedFactuality: generatedEval.factuality,
        generatedSemanticSimilarity: generatedEval.semanticSimilarity,
        generatedCompleteness: generatedEval.completeness,
        generatedISS: generatedEval.iss,
        generatedContradiction: generatedEval.contradiction,
        generatedDisclaimerPresent: generatedEval.disclaimerPresent,
        generatedInventedSpecificsTypes: generatedEval.inventedSpecificsTypes,
        generatedNotes: generatedEval.notes,
        groundLabel: groundEval.label,
        groundDomainRelevance: groundEval.domainRelevance,
        groundFactuality: groundEval.factuality,
        groundSemanticSimilarity: groundEval.semanticSimilarity,
        groundCompleteness: groundEval.completeness,
        groundISS: groundEval.iss,
        groundContradiction: groundEval.contradiction,
        groundDisclaimerPresent: groundEval.disclaimerPresent,
        groundInventedSpecificsTypes: groundEval.inventedSpecificsTypes,
        groundNotes: groundEval.notes,
        betterAnswer,
        betterReason,
        overallScoreGenerated,
        overallScoreGround,
      }
    } catch (error) {
      Logger.error(`Factuality scoring error: ${(error as Error).message}`)
      return {
        score: "20",
        thinking: `Error occurred during evaluation: ${(error as Error).message}`,
        conclusion: "Default score assigned due to error",
        cost: 0,
        detailedAnalysis: `Error occurred during evaluation: ${(error as Error).message}`,
        overallScore: "20",
        calculation: "N/A (Evaluation error)",
        generatedLabel: "UNKNOWN",
        generatedDomainRelevance: 0,
        generatedFactuality: 0,
        generatedSemanticSimilarity: 0,
        generatedCompleteness: 0,
        generatedISS: 0,
        generatedContradiction: "no",
        generatedDisclaimerPresent: "n/a",
        generatedInventedSpecificsTypes: [],
        generatedNotes: "Evaluation error occurred",
        groundLabel: "UNKNOWN",
        groundDomainRelevance: 0,
        groundFactuality: 0,
        groundSemanticSimilarity: 0,
        groundCompleteness: 0,
        groundISS: 0,
        groundContradiction: "no",
        groundDisclaimerPresent: "n/a",
        groundInventedSpecificsTypes: [],
        groundNotes: "Evaluation error occurred",
        betterAnswer: "TIE",
        betterReason: "Evaluation error occurred",
        overallScoreGenerated: 20,
        overallScoreGround: 20,
      }
    }
  }

  return await withRetry(operation, {
    maxRetries: 3,
    delayMs: 10000,
    retryCondition: (error) => {
      const errorMessage = error?.message?.toLowerCase() || ""
      const statusCode = error?.status || error?.statusCode || error?.code
      return (
        statusCode === 429 ||
        statusCode === 500 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504 ||
        errorMessage.includes("rate limit") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("network") ||
        errorMessage.includes("connection")
      )
    },
  })
}

// EVALUATION TYPES AND UTILITIES
type EvalData = {
  input: string
  expected: string
}

type EvalResult = {
  input: string
  expected: string
  output: string
  score: number
  thinking: string
  conclusion: string
  processingTime: number
  modelID: string
  detailedAnalysis?: string
  overallScore?: string
  calculation?: string
  cost?: number
  generatedLabel?: string
  generatedDomainRelevance?: number
  generatedFactuality?: number
  generatedSemanticSimilarity?: number
  generatedCompleteness?: number
  generatedISS?: number
  generatedContradiction?: string
  generatedDisclaimerPresent?: string
  generatedInventedSpecificsTypes?: string[]
  generatedNotes?: string
  groundLabel?: string
  groundDomainRelevance?: number
  groundFactuality?: number
  groundSemanticSimilarity?: number
  groundCompleteness?: number
  groundISS?: number
  groundContradiction?: string
  groundDisclaimerPresent?: string
  groundInventedSpecificsTypes?: string[]
  groundNotes?: string
  betterAnswer?: string
  betterReason?: string
  overallScoreGenerated?: number
  overallScoreGround?: number
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
    Logger.error(`Error loading test data: ${error}`)
    throw error
  }
}

function extractAnswerFromResponse(response: string): string {
  let cleanedResponse = response

  cleanedResponse = cleanedResponse.replace(
    /<analysis_and_planning>[\s\S]*?<\/analysis_and_planning>/g,
    "",
  )
  cleanedResponse = cleanedResponse.replace(
    /<question_analysis>[\s\S]*?<\/question_analysis>/g,
    "",
  )

  const answerTagMatch = cleanedResponse.match(/<answer>([\s\S]*?)<\/answer>/)
  if (answerTagMatch && answerTagMatch[1]) {
    return answerTagMatch[1].trim()
  }

  try {
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.answer) {
        return parsed.answer
      }
    }
  } catch (err) {
    // Continue to next extraction method
  }

  const jsonCodeBlockMatch = cleanedResponse.match(/```json\s*([\s\S]*?)```/)
  if (jsonCodeBlockMatch && jsonCodeBlockMatch[1]) {
    try {
      const parsed = JSON.parse(jsonCodeBlockMatch[1].trim())
      if (parsed.answer) {
        return parsed.answer
      }
    } catch (err) {
      // Continue to fallback
    }
  }

  return cleanedResponse.trim()
}

async function evaluateResponse(
  result: EvalResult,
  context: string,
): Promise<FactualityScorerResponse> {
  const { input, output, expected } = result

  console.log("\n=== EVALUATION ===")
  console.log("Input:", input.substring(0, 200) + "...")
  console.log("Generated answer:", output.substring(0, 300) + "...")
  console.log("Expected answer:", expected.substring(0, 300) + "...")
  console.log("Context:", context || "<none>")

  // Validate context availability for DPIP-related queries
  if (!context && input.toLowerCase().includes("dpip")) {
    Logger.warn("No context provided for DPIP-related query")
    return {
      score: "20",
      thinking:
        "Evaluation skipped due to missing context for DPIP-related query",
      conclusion: "Default score assigned due to missing context",
      cost: 0,
      detailedAnalysis: "No context provided for DPIP-related query",
      overallScore: "20",
      calculation: "N/A (Missing context)",
      generatedLabel: "UNKNOWN",
      generatedDomainRelevance: 0,
      generatedFactuality: 0,
      generatedSemanticSimilarity: 0,
      generatedCompleteness: 0,
      generatedISS: 0,
      generatedContradiction: "no",
      generatedDisclaimerPresent: "n/a",
      generatedInventedSpecificsTypes: [],
      generatedNotes: "Missing context",
      groundLabel: "UNKNOWN",
      groundDomainRelevance: 0,
      groundFactuality: 0,
      groundSemanticSimilarity: 0,
      groundCompleteness: 0,
      groundISS: 0,
      groundContradiction: "no",
      groundDisclaimerPresent: "n/a",
      groundInventedSpecificsTypes: [],
      groundNotes: "Missing context",
      betterAnswer: "TIE",
      betterReason: "Missing context",
      overallScoreGenerated: 20,
      overallScoreGround: 20,
    }
  }

  try {
    console.log("Evaluating response with Factuality Scorer...")
    const evaluation = await FactualityScorer(
      { modelId: defaultFastModel, stream: false },
      { input, output, expected, context },
    )

    console.log("Factuality scorer response:", evaluation)

    return evaluation
  } catch (error: any) {
    Logger.error(`Evaluation error: ${error.message}`)
    return {
      score: "20",
      thinking: `Error during evaluation: ${error.message}`,
      conclusion: "Default score assigned due to evaluation error",
      cost: 0,
      detailedAnalysis: "Error occurred during evaluation",
      overallScore: "20",
      calculation: "N/A (Evaluation error)",
      generatedLabel: "UNKNOWN",
      generatedDomainRelevance: 0,
      generatedFactuality: 0,
      generatedSemanticSimilarity: 0,
      generatedCompleteness: 0,
      generatedISS: 0,
      generatedContradiction: "no",
      generatedDisclaimerPresent: "n/a",
      generatedInventedSpecificsTypes: [],
      generatedNotes: "Evaluation error",
      groundLabel: "UNKNOWN",
      groundDomainRelevance: 0,
      groundFactuality: 0,
      groundSemanticSimilarity: 0,
      groundCompleteness: 0,
      groundISS: 0,
      groundContradiction: "no",
      groundDisclaimerPresent: "n/a",
      groundInventedSpecificsTypes: [],
      groundNotes: "Evaluation error",
      betterAnswer: "TIE",
      betterReason: "Evaluation error",
      overallScoreGenerated: 20,
      overallScoreGround: 20,
    }
  }
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
    thinking: "",
    conclusion: "",
    processingTime: 0,
    modelID: defaultBestModel,
    detailedAnalysis: "",
    overallScore: "",
    calculation: "",
    cost: 0,
    generatedLabel: "",
    generatedDomainRelevance: 0,
    generatedFactuality: 0,
    generatedSemanticSimilarity: 0,
    generatedCompleteness: 0,
    generatedISS: 0,
    generatedContradiction: "",
    generatedDisclaimerPresent: "",
    generatedInventedSpecificsTypes: [],
    generatedNotes: "",
    groundLabel: "",
    groundDomainRelevance: 0,
    groundFactuality: 0,
    groundSemanticSimilarity: 0,
    groundCompleteness: 0,
    groundISS: 0,
    groundContradiction: "",
    groundDisclaimerPresent: "",
    groundInventedSpecificsTypes: [],
    groundNotes: "",
    betterAnswer: "",
    betterReason: "",
    overallScoreGenerated: 0,
    overallScoreGround: 0,
  }

  console.log(`\n=== PROCESSING EVALUATION ITEM ===`)
  console.log(`Input: ${evalItem.input}`)
  console.log(`Expected: ${evalItem.expected}`)

  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    )
    const { user, workspace } = userAndWorkspace

    console.log(
      `Simulating agent message flow for user: ${user.id}, workspace: ${workspace.id}`,
    )

    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null

    console.log(`Using model for generation: ${modelId}`)
    if (agentId && isCuid(agentId)) {
      agentForDb = await getAgentByExternalId(db, agentId, workspace.id)
      if (!agentForDb) {
        throw new HTTPException(403, {
          message: "Access denied: You don't have permission to use this agent",
        })
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
    }

    const message = decodeURIComponent(evalItem.input)
    let finalAnswer = ""

    const messages = [
      {
        messageRole: MessageRole.User,
        message: message,
        fileIds: [],
      },
    ]

    const messagesWithNoErrResponse = messages.map((msg) => ({
      role: msg.messageRole as ConversationRole,
      content: [{ text: msg.message }],
    }))

    let fragments: MinimalAgentFragment[] = []
    let finalImageFileNames: string[] = []
    let kbDocIds: string[] = []
    if (agentForDb && agentForDb.appIntegrations) {
      kbDocIds = agentForDb.appIntegrations
        .filter(
          (integration: string) =>
            integration.toLowerCase().startsWith("kb-") ||
            integration.toLowerCase().startsWith("kb_"),
        )
        .map((kbIntegration: string) => kbIntegration.replace(/^kb[-_]/i, ""))
    }

    if (kbDocIds.length > 0) {
      try {
        const allChunks = await GetKbFilesByKbIds(kbDocIds)
        if (allChunks?.root?.children?.length > 0) {
          fragments = allChunks.root.children.map(
            (child: VespaSearchResult, idx: number) =>
              vespaResultToMinimalAgentFragment(child, idx),
          )
          context = answerContextMapFromFragments(
            allChunks.root.children.map((child: VespaSearchResult) => ({
              id: `${(child.fields as any)?.docId || `Fragment_id_${Date.now()}`}`,
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
          )
          const { imageFileNames } = extractImageFileNames(
            context,
            fragments.map((v, idx) => ({
              id: v.source.docId || `fragment_${idx}`,
              relevance: 1.0,
              label: v.source.title || "unknown",
              fields: {
                "count()": 1,
                docId: v.source.docId,
                title: v.source.title || "",
                url: v.source.url || "",
              },
            })),
          )
          finalImageFileNames = imageFileNames || []
          console.log(`Context: ${context}`)
        }
      } catch (error) {
        Logger.error(`Failed to fetch KB files: ${(error as Error).message}`)
      }
    }

    const integrationConfigs = await getIntegrationConfigurationsByWorkspace(
      db,
      workspace.id,
    )
    let configString = ""
    if (integrationConfigs.length > 0) {
      configString = `
${integrationConfigs
  .map(
    (config) =>
      `- integrationType: ${config.integrationType}, edgeRequirement: ${config.edgeRequirement}, responseFormat: ${config.responseFormat}, backendLanguage: ${config.backendLanguage}, languageVersion: ${config.languageVersion}`,
  )
  .join("\n")}
`
    }
    const config = integrationConfigs[0]
      ? dpipFormParams(
          integrationConfigs[0].integrationType as "API" | "SDK",
          integrationConfigs[0].edgeRequirement as
            | "Complete Edge server"
            | "Only Bloom",
          integrationConfigs[0].responseFormat as "JSON" | "XML",
          integrationConfigs[0].backendLanguage as "Java" | "Python" | ".net",
        )
      : ""
    const prompt = dpipJourneyPrompt(config, [], context)

    const tracer: Tracer = getTracer("chat")
    const rootSpan = tracer.startSpan("AgentMessageApiRagOff")
    const ragOffIterator = nonRagIterator(
      message,
      userCtx,
      context,
      fragments,
      agentPromptForLLM,
      messagesWithNoErrResponse,
      finalImageFileNames,
      [],
      myEmail,
      false,
      configString,
      prompt,
    )

    console.log(`Processing RAG-off stream with model: ${defaultBestModel}`)
    let chunkCount = 0
    for await (const chunk of ragOffIterator) {
      if (chunk.text && !chunk.reasoning) {
        finalAnswer += chunk.text
        chunkCount++
      }
    }

    result.output = finalAnswer || "No answer generated"
    console.log(`Generated output: ${result.output}`)
  } catch (error) {
    Logger.error(`Error in agent message flow: ${(error as Error).message}`)
    result.output = `Error: ${(error as Error).message}`
    result.score = 0
    result.thinking = `Error during generation: ${(error as Error).message}`
    result.conclusion = "Generation failed"
    result.detailedAnalysis = "Error occurred during generation"
    result.overallScore = "0"
    result.calculation = "N/A (Generation error)"
  }

  result.processingTime = Date.now() - startTime

  if (result.output && result.expected && !result.output.startsWith("Error:")) {
    const evaluation = await evaluateResponse(result, context)

    // Assign the score from the evaluation
    const numericScore = parseFloat(evaluation.score) || 0
    result.score = Math.round(numericScore) // Round to nearest integer for consistency

    // Assign other evaluation fields
    result.thinking = evaluation.thinking
    result.conclusion = evaluation.conclusion
    result.detailedAnalysis = evaluation.detailedAnalysis
    result.overallScore = evaluation.overallScore
    result.calculation = evaluation.calculation
    result.cost = evaluation.cost
    result.generatedLabel = evaluation.generatedLabel
    result.generatedDomainRelevance = evaluation.generatedDomainRelevance
    result.generatedFactuality = evaluation.generatedFactuality
    result.generatedSemanticSimilarity = evaluation.generatedSemanticSimilarity
    result.generatedCompleteness = evaluation.generatedCompleteness
    result.generatedISS = evaluation.generatedISS
    result.generatedContradiction = evaluation.generatedContradiction
    result.generatedDisclaimerPresent = evaluation.generatedDisclaimerPresent
    result.generatedInventedSpecificsTypes =
      evaluation.generatedInventedSpecificsTypes
    result.generatedNotes = evaluation.generatedNotes
    result.groundLabel = evaluation.groundLabel
    result.groundDomainRelevance = evaluation.groundDomainRelevance
    result.groundFactuality = evaluation.groundFactuality
    result.groundSemanticSimilarity = evaluation.groundSemanticSimilarity
    result.groundCompleteness = evaluation.groundCompleteness
    result.groundISS = evaluation.groundISS
    result.groundContradiction = evaluation.groundContradiction
    result.groundDisclaimerPresent = evaluation.groundDisclaimerPresent
    result.groundInventedSpecificsTypes =
      evaluation.groundInventedSpecificsTypes
    result.groundNotes = evaluation.groundNotes
    result.betterAnswer = evaluation.betterAnswer
    result.betterReason = evaluation.betterReason

    // Calculate and assign overallScoreGenerated and overallScoreGround
    result.overallScoreGenerated =
      evaluation.overallScoreGenerated ||
      Math.round(
        (evaluation.generatedDomainRelevance * 0.25 +
          evaluation.generatedFactuality * 0.35 +
          evaluation.generatedSemanticSimilarity * 0.25 +
          evaluation.generatedCompleteness * 0.15 -
          evaluation.generatedISS * 0.1) *
          20,
      )
    result.overallScoreGround =
      evaluation.overallScoreGround ||
      Math.round(
        (evaluation.groundDomainRelevance * 0.25 +
          evaluation.groundFactuality * 0.35 +
          evaluation.groundSemanticSimilarity * 0.25 +
          evaluation.groundCompleteness * 0.15 -
          evaluation.groundISS * 0.1) *
          20,
      )

    // Ensure the score field aligns with overallScoreGenerated for consistency
    if (result.score !== result.overallScoreGenerated) {
      Logger.warn(
        `Score mismatch: Reported=${result.score}, Calculated=${result.overallScoreGenerated}. Using calculated score.`,
      )
      result.score = result.overallScoreGenerated
    }

    Logger.info(
      `Evaluation completed: score=${result.score}, overallScoreGenerated=${result.overallScoreGenerated}, overallScoreGround=${result.overallScoreGround}`,
    )
  } else {
    result.score = 0
    result.thinking = "Evaluation skipped due to generation error"
    result.conclusion = "No evaluation performed"
    result.detailedAnalysis = "Evaluation skipped due to generation error"
    result.overallScore = "0"
    result.calculation = "N/A (No evaluation performed)"
    result.overallScoreGenerated = 0
    result.overallScoreGround = 0
  }

  return result
}

function saveEvalResults(
  evaluation: {
    sessionId: string
    averageScore: number
    averageProcessingTime: number
    scoreDistribution: {
      excellent: number
      good: number
      fair: number
      poor: number
    }
    results: EvalResult[]
    evaluationMetadata: {
      totalQueries: number
      avgProcessingTime: number
      evaluationModel: string
      timestamp: string
      enhancedReasoningEnabled: boolean
    }
  },
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

  const outputData = {
    sessionId: evaluation.sessionId,
    completedCount: evaluation.results.length,
    averageScore: evaluation.averageScore,
    averageProcessingTime: evaluation.averageProcessingTime,
    scoreDistribution: evaluation.scoreDistribution,
    results: evaluation.results.map((result) => ({
      input: result.input,
      expected: result.expected,
      output: result.output,
      score: result.score,
      thinking: result.thinking,
      conclusion: result.conclusion,
      processingTime: result.processingTime,
      modelID: result.modelID,
      detailedAnalysis: result.detailedAnalysis,
      overallScore: result.overallScore,
      calculation: result.calculation,
      cost: result.cost,
      generatedLabel: result.generatedLabel,
      generatedDomainRelevance: result.generatedDomainRelevance,
      generatedFactuality: result.generatedFactuality,
      generatedSemanticSimilarity: result.generatedSemanticSimilarity,
      generatedCompleteness: result.generatedCompleteness,
      generatedISS: result.generatedISS,
      generatedContradiction: result.generatedContradiction,
      generatedDisclaimerPresent: result.generatedDisclaimerPresent,
      generatedInventedSpecificsTypes: result.generatedInventedSpecificsTypes,
      generatedNotes: result.generatedNotes,
      groundLabel: result.groundLabel,
      groundDomainRelevance: result.groundDomainRelevance,
      groundFactuality: result.groundFactuality,
      groundSemanticSimilarity: result.groundSemanticSimilarity,
      groundCompleteness: result.groundCompleteness,
      groundISS: result.groundISS,
      groundContradiction: result.groundContradiction,
      groundDisclaimerPresent: result.groundDisclaimerPresent,
      groundInventedSpecificsTypes: result.groundInventedSpecificsTypes,
      groundNotes: result.groundNotes,
      betterAnswer: result.betterAnswer,
      betterReason: result.betterReason,
      overallScoreGenerated: result.overallScoreGenerated,
      overallScoreGround: result.overallScoreGround,
    })),
    lastUpdated: new Date().toISOString(),
    evaluationMetadata: {
      evaluationModel: evaluation.evaluationMetadata.evaluationModel,
      enhancedReasoningEnabled:
        evaluation.evaluationMetadata.enhancedReasoningEnabled,
    },
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2))
    Logger.info(`Evaluation results saved to: ${filePath}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

function saveProgressResults(results: EvalResult[], sessionId: string) {
  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
  )
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true })
  }

  const avgScore =
    results.length > 0
      ? Math.round(
          results.reduce((sum, r) => sum + r.score, 0) / results.length,
        )
      : 0
  const avgProcessingTime =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.processingTime, 0) / results.length
      : 0

  const scoreDistribution = {
    excellent: results.filter((r) => r.score >= 80).length,
    good: results.filter((r) => r.score >= 60 && r.score < 80).length,
    fair: results.filter((r) => r.score >= 40 && r.score < 60).length,
    poor: results.filter((r) => r.score < 40).length,
  }

  const progressData = {
    sessionId,
    completedCount: results.length,
    averageScore: avgScore,
    averageProcessingTime: avgProcessingTime,
    scoreDistribution,
    results: results.map((result) => ({
      input: result.input,
      expected: result.expected,
      output: result.output,
      score: result.score,
      thinking: result.thinking,
      conclusion: result.conclusion,
      processingTime: result.processingTime,
      modelID: result.modelID,
      detailedAnalysis: result.detailedAnalysis,
      overallScore: result.overallScore,
      calculation: result.calculation,
      cost: result.cost,
      generatedLabel: result.generatedLabel,
      generatedDomainRelevance: result.generatedDomainRelevance,
      generatedFactuality: result.generatedFactuality,
      generatedSemanticSimilarity: result.generatedSemanticSimilarity,
      generatedCompleteness: result.generatedCompleteness,
      generatedISS: result.generatedISS,
      generatedContradiction: result.generatedContradiction,
      generatedDisclaimerPresent: result.generatedDisclaimerPresent,
      generatedInventedSpecificsTypes: result.generatedInventedSpecificsTypes,
      generatedNotes: result.generatedNotes,
      groundLabel: result.groundLabel,
      groundDomainRelevance: result.groundDomainRelevance,
      groundFactuality: result.groundFactuality,
      groundSemanticSimilarity: result.groundSemanticSimilarity,
      groundCompleteness: result.groundCompleteness,
      groundISS: result.groundISS,
      groundContradiction: result.groundContradiction,
      groundDisclaimerPresent: result.groundDisclaimerPresent,
      groundInventedSpecificsTypes: result.groundInventedSpecificsTypes,
      groundNotes: result.groundNotes,
      betterAnswer: result.betterAnswer,
      betterReason: result.betterReason,
      overallScoreGenerated: result.overallScoreGenerated,
      overallScoreGround: result.overallScoreGround,
    })),
    lastUpdated: new Date().toISOString(),
    evaluationMetadata: {
      evaluationModel: defaultFastModel,
      enhancedReasoningEnabled: true,
    },
  }

  const progressFileName = `progress-${sessionId}.json`
  const progressFilePath = path.join(evalResultsDir, progressFileName)

  try {
    fs.writeFileSync(progressFilePath, JSON.stringify(progressData, null, 2))
    Logger.info(`Progress results saved to: ${progressFilePath}`)
  } catch (error) {
    Logger.error(
      `Failed to save progress results to ${progressFilePath}: ${error}`,
    )
  }
}

async function runEvaluation(userCtx: string) {
  const data = loadTestData()
  const results: EvalResult[] = []

  const sessionId = new Date().toISOString().replace(/[:.]/g, "-")

  Logger.info("Starting Enhanced Agent Message API evaluation...")
  Logger.info(`Session ID: ${sessionId}`)
  Logger.info("User context:\n" + userCtx)

  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    console.log(pc.cyan(`\n📋 Test Case ${i + 1}/${data.length}`))
    console.log(`❓ Query: "${item.input.substring(0, 100)}..."`)
    Logger.info(`Processing query: "${JSON.stringify(item)}"`)

    const result = await simulateAgentMessageFlowWithRagOff(item, userCtx)
    results.push(result)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer: ${result.output}`)
    Logger.info(`- Score: ${result.score}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)
    Logger.info(`- Evaluation thinking: ${result.thinking}`)
    Logger.info(`- Evaluation conclusion: ${result.conclusion}`)
    Logger.info(`- Detailed analysis: ${result.detailedAnalysis}`)
    Logger.info(`- Overall score: ${result.overallScore}`)
    Logger.info(`- Calculation: ${result.calculation}`)

    saveProgressResults(results, sessionId)

    if (i < data.length - 1) {
      await sleep(1000)
    }
  }

  const avgScore =
    results.length > 0
      ? Math.round(
          results.reduce((sum, r) => sum + r.score, 0) / results.length,
        )
      : 0
  const avgProcessingTime =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.processingTime, 0) / results.length
      : 0

  console.log(pc.green(`\n🎉 ENHANCED EVALUATION COMPLETE`))
  console.log(pc.blue(`📊 Average Score: ${avgScore}%`))
  console.log(
    pc.blue(`⏱️  Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`),
  )

  const scoreDistribution = {
    excellent: results.filter((r) => r.score >= 80).length,
    good: results.filter((r) => r.score >= 60 && r.score < 80).length,
    fair: results.filter((r) => r.score >= 40 && r.score < 60).length,
    poor: results.filter((r) => r.score < 40).length,
  }

  const enhancedResults = {
    sessionId: sessionId,
    averageScore: avgScore,
    averageProcessingTime: avgProcessingTime,
    scoreDistribution: scoreDistribution,
    results: results,
    evaluationMetadata: {
      totalQueries: data.length,
      avgProcessingTime: avgProcessingTime,
      evaluationModel: defaultFastModel,
      timestamp: new Date().toISOString(),
      enhancedReasoningEnabled: true,
    },
  }

  const savedFileName = saveEvalResults(
    enhancedResults,
    "enhanced-agent-message-eval-final",
  )

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
