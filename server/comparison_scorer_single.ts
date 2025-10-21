import * as fs from "fs/promises"
import * as path from "path"
import * as dotenv from "dotenv"

// Load environment variables
dotenv.config({ path: "../../server/.env" })

// Configuration for OSS 120B endpoint
const BASE_URL = "https://veronica.pratikn.com"
const OPENAI_API_KEY = "sk-HrawW9WcLJh4125CkMfvwg"
const OPENAI_MODEL = "azure_ai/gpt-oss-120b"

// Default input and output file paths
const DEFAULT_OLD_EVAL_FILE =
  "/Users/telkar.varasree/Downloads/xyne/server/api_agentic_answers.json"
const DEFAULT_NEW_EVAL_FILE =
  "/Users/telkar.varasree/Downloads/xyne/server/tool_revamp_agentic.json"
const DEFAULT_OUTPUT_FILE =
  "/Users/telkar.varasree/Downloads/xyne/server/comparison_results.json"

// Interface for the comparison evaluation item
interface ComparisonEvaluationItem {
  User_data: {
    UserID: string
    User_name: string
  }
  Question_weights: {
    Coverage_preference: string
    Vagueness: number
    Question_Complexity: string
    Realness: string
    Reasoning: string
    Question_format: string
  }
  Question: string
  Answer_weights: {
    Factuality: number
    Completeness: number
    Domain_relevance: number
  }
  Answer: string // Ground truth
  Confidence: number
  old_Agentic_answer: string
  new_Agentic_answer: string
}

// Interface for the output with scores
interface ScoredComparisonItem extends ComparisonEvaluationItem {
  old_score: {
    Factuality: number
    Completeness: number
    Overall_Score: number
    Reason: string
    Insights: string
  }
  new_score: {
    Factuality: number
    Completeness: number
    Overall_Score: number
    Reason: string
    Insights: string
  }
  comparison: {
    better_answer: "old" | "new" | "tie"
    overall_assessment: string
    key_differences: string
  }
}

// Call OSS 120B LLM with prompt for scoring
async function callLLMForScoring(
  prompt: string,
  batchNumber: number,
  batch: ComparisonEvaluationItem[],
  maxRetries = 5,
): Promise<any> {
  console.log(
    `🔧 Starting LLM scoring call for batch ${batchNumber} using model: ${OPENAI_MODEL} (max ${maxRetries} retries for parsing errors)`,
  )

  let lastError: any
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `📡 Attempt ${attempt}/${maxRetries} for batch ${batchNumber}...`,
      )

      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 8000,
          response_format: { type: "json_object" },
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      console.log(
        `📊 Response received for batch ${batchNumber}, status: ${response.status}`,
      )
      const data = await response.json()

      if (
        !data.choices ||
        !data.choices[0] ||
        !data.choices[0].message ||
        !data.choices[0].message.content
      ) {
        throw new Error(
          `Invalid response structure for batch ${batchNumber}: ${JSON.stringify(data)}`,
        )
      }

      const content = data.choices[0].message.content.trim()
      console.log(
        `📝 Content received for batch ${batchNumber}, length: ${content.length} chars`,
      )

      let parsedContent
      try {
        parsedContent = JSON.parse(content)
        console.log(
          `✅ Successfully parsed JSON for batch ${batchNumber} on attempt ${attempt}`,
        )
      } catch (parseError) {
        console.error(
          `❌ JSON parse error for batch ${batchNumber}, attempt ${attempt}/${maxRetries}:`,
          parseError,
        )
        console.error(
          `Raw content (first 500 chars): ${content.substring(0, 500)}...`,
        )
        // Throw error to trigger retry for parsing issues (will retry up to 5 times)
        throw new Error(
          `Failed to parse JSON response for batch ${batchNumber}, attempt ${attempt}: ${parseError}`,
        )
      }

      // Handle response format - expect either an array or an object with results
      if (parsedContent.results && Array.isArray(parsedContent.results)) {
        console.log(
          `✅ Parsed structured response for batch ${batchNumber} with ${parsedContent.results.length} results`,
        )
        return parsedContent.results
      } else if (Array.isArray(parsedContent)) {
        console.log(
          `✅ Parsed array response for batch ${batchNumber} with ${parsedContent.length} results`,
        )
        return parsedContent
      } else {
        console.error(
          `❌ Unexpected response format for batch ${batchNumber}:`,
          parsedContent,
        )
        throw new Error(`Unexpected response format for batch ${batchNumber}`)
      }
    } catch (err: any) {
      lastError = err
      const isParsingError = err.message.includes(
        "Failed to parse JSON response",
      )
      console.error(
        `❌ Attempt ${attempt}/${maxRetries} failed for batch ${batchNumber}${isParsingError ? " (JSON parsing error)" : ""}:`,
        err.message,
      )

      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000
        console.log(
          `⏳ Retrying in ${delayMs}ms${isParsingError ? " due to parsing error" : ""}...`,
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }

  throw new Error(
    `LLM scoring call failed for batch ${batchNumber} after ${maxRetries} attempts (including parsing error retries). Last error: ${lastError}`,
  )
}

// Create comparison scoring prompt for a batch of items
function createComparisonScoringPrompt(
  batch: ComparisonEvaluationItem[],
): string {
  const promptText = `You are an EXPERT COMPARISON EVALUATION SYSTEM designed to score and compare old vs new agentic answer quality for Retrieval-Augmented Generation (RAG) systems. Your task is to evaluate both answers against ground truth and provide precise comparative analysis.

CORE EVALUATION PRINCIPLES:

Objectivity First: Base scores on observable evidence, not assumptions

Consistency: Apply the same standards across all evaluations

Granularity & Differentiation: Use the full 1-10 scale with high sensitivity to differences. Score comparatively—compare both answers directly against each other and the ground truth simultaneously, not independently. Small differences in factual precision, relevance, or completeness must result in noticeable score differences (≥1 point difference). Avoid clustering around middle values or assigning similar scores unless both are equally strong.

Evidence-Based: Every score must be justified with specific examples

Comparative Analysis: Always compare both old_Agentic_answer and new_Agentic_answer head-to-head against ground truth (Answer field) before assigning scores. If one answer is moderately better, reflect with at least a 1-point gap.

SCORING CRITERIA:
Evaluate each answer pair on these TWO factors (scale 1-10). Each score must be an integer with clear justification.
CRITICAL: First verify that the answer actually addresses the specific question asked. Then evaluate factuality and completeness.

Factuality (1-10):
Definition: Correctness and accuracy of information when compared to ground truth. Focus on identifying contradictions, verifying claims, assessing information accuracy, and detecting hallucinations (made-up or unrelated information). Ensure the answer directly addresses what was asked in the question.

Scoring Rubric:

Score 10 (Perfect): Zero contradictions with ground truth, all information accurate, directly addresses the question, no hallucinations

Score 7-9 (High): No direct contradictions, minor deviations in presentation but same core facts, stays on topic, minimal irrelevant content

Score 4-6 (Moderate): Mix of accurate and inaccurate information, some contradictions on secondary points, may include some irrelevant content or minor hallucinations

Score 1-3 (Poor): Significant factual errors, direct contradictions, major hallucinations (completely unrelated information), fails to address the question

Partial matches, paraphrases that alter meaning, or unsupported additions should reduce the factuality score noticeably (1-3 point deduction).

Completeness (1-10):
Definition: How thoroughly the answer addresses all aspects of the specific question asked, compared to the ground truth. Prioritize relevance to the question over exhaustive coverage of ground truth content.

Scoring Rubric:

Score 10 (Fully Complete): Directly answers what was asked, covers all relevant aspects from ground truth, no significant omissions, stays focused on the question

Score 7-9 (Mostly Complete): Addresses the main question well, covers most relevant points from ground truth, minor gaps in specific details

Score 4-6 (Partially Complete): Addresses the question but misses important relevant elements, includes some irrelevant information

Score 1-3 (Incomplete): Fails to properly address the question, major gaps, mostly irrelevant or off-topic content

COMPARISON ANALYSIS:
After scoring both answers, perform detailed comparison:

Better Answer: Compare answers based on how well they address the specific question and their factuality/completeness scores

Overall Assessment: 2-3 sentence summary of which answer is better and why

Key Differences: List 3-5 specific differences between the answers, focusing on relevance to the question asked

OVERALL_SCORE CALCULATION: Calculate as the average of Factuality and Completeness scores: Overall_Score = (Factuality + Completeness) / 2. This should be a decimal number (e.g., 7.5, 6.0, 8.5).

REASON FIELD: Template: "Factuality scored [X] because [specific observation]. Completeness scored [Y] because [specific observation]. Overall_Score is [Z] (average of Factuality and Completeness)."

INSIGHTS FIELD: Structure with MISSING TRUTH, CONTRADICTIONS, DEVIATIONS, ADDITIONAL CONTEXT, and OVERALL assessment.

You must return ONLY valid JSON in this exact format:

{
"results": [
{
"User_data": { "UserID": "...", "User_name": "..." },
"Question_weights": { "Coverage_preference": "...", "Vagueness": 0, "Question_Complexity": "...", "Realness": "...", "Reasoning": "...", "Question_format": "..." },
"Question": "...",
"Answer_weights": { "Factuality": 1, "Completeness": 1, "Domain_relevance": 1 },
"Answer": "...",
"Confidence": 1,
"old_Agentic_answer": "...",
"new_Agentic_answer": "...",
"old_score": {
"Factuality": X,
"Completeness": Y,
"Overall_Score": Z,
"Reason": "Factuality scored X because [observation]. Completeness scored Y because [observation]. Overall_Score is Z (average of Factuality and Completeness).",
"Insights": "MISSING TRUTH: ... CONTRADICTIONS: ... DEVIATIONS: ... ADDITIONAL CONTEXT: ... OVERALL: ..."
},
"new_score": {
"Factuality": X,
"Completeness": Y,
"Overall_Score": Z,
"Reason": "Factuality scored X because [observation]. Completeness scored Y because [observation]. Overall_Score is Z (average of Factuality and Completeness).",
"Insights": "MISSING TRUTH: ... CONTRADICTIONS: ... DEVIATIONS: ... ADDITIONAL CONTEXT: ... OVERALL: ..."
},
"comparison": {
"better_answer": "old or new",
"overall_assessment": "The [old/new] answer provides better factual accuracy and completeness compared to ground truth. The [old/new] answer aligns more closely with the ground truth categories and directly addresses the question asked.",
"key_differences": "1) ... 2) ... 3) ... 4) ..."
}
}
]
}

CRITICAL INSTRUCTIONS:

Return ONLY valid JSON - No markdown, no code blocks, no explanations outside the JSON

Wrap in "results" array - Follow exact format above

Preserve all original fields exactly as provided in input

Use integer scores only (1-10, no decimals for Factuality and Completeness)

Ensure valid JSON syntax - No trailing commas, proper escaping

Input Data: ${JSON.stringify(batch, null, 2)}

For each item:

"Question" is the question being asked

"Answer" is the Ground Truth

"old_Agentic_answer" is the old answer to evaluate

"new_Agentic_answer" is the new answer to evaluate

Score both answers against the ground truth using Factuality and Completeness (with question alignment considered within these factors), then provide comparison analysis.`

  return promptText
}

// Process a batch of items for comparison scoring
async function processComparisonBatch(
  batch: ComparisonEvaluationItem[],
  batchNumber: number,
): Promise<ScoredComparisonItem[]> {
  console.log(
    `📊 Processing comparison batch ${batchNumber} with ${batch.length} items...`,
  )

  try {
    const prompt = createComparisonScoringPrompt(batch)
    console.log(
      `📝 Created comparison scoring prompt for batch ${batchNumber} (length: ${prompt.length} chars)`,
    )

    const scoredResults = await callLLMForScoring(prompt, batchNumber, batch)
    console.log(
      `✅ Received comparison scoring results for batch ${batchNumber}`,
    )

    // Validate that we got the expected number of results
    if (!Array.isArray(scoredResults)) {
      throw new Error(
        `Expected array response for batch ${batchNumber}, got: ${typeof scoredResults}`,
      )
    }

    // Validate each result has the required score fields
    const validatedResults: ScoredComparisonItem[] = []
    for (let i = 0; i < scoredResults.length && i < batch.length; i++) {
      const result = scoredResults[i]
      const originalItem = batch[i]

      if (result.error) {
        console.error(
          `❌ Error in batch ${batchNumber}, item ${i}:`,
          result.error,
        )
        // Create a default score for error cases
        const defaultOldScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1,
          Reason: "Error occurred during evaluation after 5 retry attempts",
          Insights:
            "Unable to evaluate due to processing error after multiple retries",
        }
        const defaultNewScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1,
          Reason: "Error occurred during evaluation after 5 retry attempts",
          Insights:
            "Unable to evaluate due to processing error after multiple retries",
        }
        const defaultComparison = {
          better_answer: "tie" as const,
          overall_assessment: "Unable to compare due to processing error",
          key_differences: "Evaluation failed",
        }
        validatedResults.push({
          ...originalItem,
          old_score: defaultOldScore,
          new_score: defaultNewScore,
          comparison: defaultComparison,
        })
      } else if (
        result.old_score &&
        result.new_score &&
        result.comparison &&
        typeof result.old_score.Factuality === "number" &&
        typeof result.old_score.Completeness === "number" &&
        typeof result.old_score.Overall_Score === "number" &&
        typeof result.new_score.Factuality === "number" &&
        typeof result.new_score.Completeness === "number" &&
        typeof result.new_score.Overall_Score === "number"
      ) {
        validatedResults.push(result as ScoredComparisonItem)
        console.log(
          `✅ Batch ${batchNumber}, item ${i}: Valid comparison scores received`,
        )
      } else {
        console.warn(
          `⚠️  Batch ${batchNumber}, item ${i}: Invalid score format, using defaults`,
        )
        const defaultOldScore = {
          Factuality: 5,
          Completeness: 5,
          Overall_Score: 5,
          Reason:
            "Default scores applied due to invalid format after 5 retry attempts",
          Insights:
            "Unable to parse evaluation results despite multiple retries",
        }
        const defaultNewScore = {
          Factuality: 5,
          Completeness: 5,
          Overall_Score: 5,
          Reason:
            "Default scores applied due to invalid format after 5 retry attempts",
          Insights:
            "Unable to parse evaluation results despite multiple retries",
        }
        const defaultComparison = {
          better_answer: "tie" as const,
          overall_assessment: "Unable to determine due to invalid format",
          key_differences: "Could not parse comparison results",
        }
        validatedResults.push({
          ...originalItem,
          old_score: defaultOldScore,
          new_score: defaultNewScore,
          comparison: defaultComparison,
        })
      }
    }

    console.log(
      `✅ Batch ${batchNumber} processing completed with ${validatedResults.length} valid results`,
    )
    return validatedResults
  } catch (error) {
    console.error(`❌ Error processing batch ${batchNumber}:`, error)

    // Return batch with default scores in case of error
    const defaultScoredBatch: ScoredComparisonItem[] = batch.map(
      (item, index) => {
        console.log(
          `⚠️  Applying default scores to batch ${batchNumber}, item ${index} due to error`,
        )
        const defaultOldScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1,
          Reason: "Error during evaluation process after 5 retry attempts",
          Insights: "Processing failed despite multiple retries",
        }
        const defaultNewScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1,
          Reason: "Error during evaluation process after 5 retry attempts",
          Insights: "Processing failed despite multiple retries",
        }
        const defaultComparison = {
          better_answer: "tie" as const,
          overall_assessment: "Unable to compare due to processing error",
          key_differences: "Evaluation failed",
        }
        return {
          ...item,
          old_score: defaultOldScore,
          new_score: defaultNewScore,
          comparison: defaultComparison,
        }
      },
    )

    return defaultScoredBatch
  }
}

// Interface for score analysis results
interface ScoreAnalysis {
  totalQueries: number
  validQueries: number
  averageScores: {
    oldFactuality: number
    newFactuality: number
    oldCompleteness: number
    newCompleteness: number
    oldOverall: number
    newOverall: number
  }
  comparisonStats: {
    oldWins: number
    newWins: number
    ties: number
    factualityOldWins: number
    factualityNewWins: number
    factualityTies: number
    completenessOldWins: number
    completenessNewWins: number
    completenessTies: number
  }
  perQueryAnalysis: Array<{
    question: string
    questionId: number
    oldScores: {
      factuality: number
      completeness: number
      overall: number
    }
    newScores: {
      factuality: number
      completeness: number
      overall: number
    }
    winner: string
    scoreDifferences: {
      factuality: number
      completeness: number
      overall: number
    }
  }>
}

// Calculate detailed score analysis for all queries
function calculateDetailedScoreAnalysis(
  scoredResults: ScoredComparisonItem[],
): ScoreAnalysis {
  console.log(`\n📊 CALCULATING DETAILED SCORE ANALYSIS...`)

  let totalOldFactuality = 0,
    totalNewFactuality = 0
  let totalOldCompleteness = 0,
    totalNewCompleteness = 0
  let totalOldOverall = 0,
    totalNewOverall = 0
  let validScoreCount = 0

  // Comparison statistics
  let oldWins = 0,
    newWins = 0,
    ties = 0
  let factualityOldWins = 0,
    factualityNewWins = 0,
    factualityTies = 0
  let completenessOldWins = 0,
    completenessNewWins = 0,
    completenessTies = 0

  // Per-query analysis
  const perQueryAnalysis: ScoreAnalysis["perQueryAnalysis"] = []

  for (let i = 0; i < scoredResults.length; i++) {
    const item = scoredResults[i]

    if (item.old_score && item.new_score && item.comparison) {
      // Extract scores
      const oldFactuality = item.old_score.Factuality
      const oldCompleteness = item.old_score.Completeness
      const oldOverall = item.old_score.Overall_Score
      const newFactuality = item.new_score.Factuality
      const newCompleteness = item.new_score.Completeness
      const newOverall = item.new_score.Overall_Score

      // Add to totals
      totalOldFactuality += oldFactuality
      totalNewFactuality += newFactuality
      totalOldCompleteness += oldCompleteness
      totalNewCompleteness += newCompleteness
      totalOldOverall += oldOverall
      totalNewOverall += newOverall
      validScoreCount++

      // Overall comparison stats
      switch (item.comparison.better_answer) {
        case "old":
          oldWins++
          break
        case "new":
          newWins++
          break
        case "tie":
          ties++
          break
      }

      // Factuality comparison stats based on individual scores
      if (oldFactuality > newFactuality) {
        factualityOldWins++
      } else if (newFactuality > oldFactuality) {
        factualityNewWins++
      } else {
        factualityTies++
      }

      // Completeness comparison stats based on individual scores
      if (oldCompleteness > newCompleteness) {
        completenessOldWins++
      } else if (newCompleteness > oldCompleteness) {
        completenessNewWins++
      } else {
        completenessTies++
      }

      // Per-query analysis
      perQueryAnalysis.push({
        question:
          item.Question.substring(0, 100) +
          (item.Question.length > 100 ? "..." : ""),
        questionId: i + 1,
        oldScores: {
          factuality: oldFactuality,
          completeness: oldCompleteness,
          overall: oldOverall,
        },
        newScores: {
          factuality: newFactuality,
          completeness: newCompleteness,
          overall: newOverall,
        },
        winner: item.comparison.better_answer,
        scoreDifferences: {
          factuality: newFactuality - oldFactuality,
          completeness: newCompleteness - oldCompleteness,
          overall: newOverall - oldOverall,
        },
      })
    }
  }

  // Calculate averages
  const averageScores =
    validScoreCount > 0
      ? {
          oldFactuality: totalOldFactuality / validScoreCount,
          newFactuality: totalNewFactuality / validScoreCount,
          oldCompleteness: totalOldCompleteness / validScoreCount,
          newCompleteness: totalNewCompleteness / validScoreCount,
          oldOverall: totalOldOverall / validScoreCount,
          newOverall: totalNewOverall / validScoreCount,
        }
      : {
          oldFactuality: 0,
          newFactuality: 0,
          oldCompleteness: 0,
          newCompleteness: 0,
          oldOverall: 0,
          newOverall: 0,
        }

  const comparisonStats = {
    oldWins,
    newWins,
    ties,
    factualityOldWins,
    factualityNewWins,
    factualityTies,
    completenessOldWins,
    completenessNewWins,
    completenessTies,
  }

  console.log(
    `✅ Analysis completed for ${validScoreCount} valid queries out of ${scoredResults.length} total`,
  )

  return {
    totalQueries: scoredResults.length,
    validQueries: validScoreCount,
    averageScores,
    comparisonStats,
    perQueryAnalysis,
  }
}

// Display detailed score analysis
function displayScoreAnalysis(analysis: ScoreAnalysis): void {
  console.log(`\n📈 DETAILED SCORE ANALYSIS REPORT`)
  console.log(`═══════════════════════════════════════════════════════════════`)

  // Basic stats
  console.log(`\n📊 BASIC STATISTICS:`)
  console.log(`📝 Total Queries Processed: ${analysis.totalQueries}`)
  console.log(`✅ Valid Queries with Scores: ${analysis.validQueries}`)

  if (analysis.validQueries === 0) {
    console.log(`⚠️  No valid queries found for analysis!`)
    return
  }

  // Average scores
  console.log(`\n📊 AVERAGE SCORES (Scale 1-10):`)
  console.log(`┌─────────────────┬─────────┬─────────┬────────────┐`)
  console.log(`│ Metric          │ Old     │ New     │ Difference │`)
  console.log(`├─────────────────┼─────────┼─────────┼────────────┤`)
  console.log(
    `│ Factuality      │ ${analysis.averageScores.oldFactuality.toFixed(2).padStart(7)} │ ${analysis.averageScores.newFactuality.toFixed(2).padStart(7)} │ ${(analysis.averageScores.newFactuality - analysis.averageScores.oldFactuality >= 0 ? "+" : "") + (analysis.averageScores.newFactuality - analysis.averageScores.oldFactuality).toFixed(2).padStart(9)} │`,
  )
  console.log(
    `│ Completeness    │ ${analysis.averageScores.oldCompleteness.toFixed(2).padStart(7)} │ ${analysis.averageScores.newCompleteness.toFixed(2).padStart(7)} │ ${(analysis.averageScores.newCompleteness - analysis.averageScores.oldCompleteness >= 0 ? "+" : "") + (analysis.averageScores.newCompleteness - analysis.averageScores.oldCompleteness).toFixed(2).padStart(9)} │`,
  )
  console.log(
    `│ Overall Average │ ${analysis.averageScores.oldOverall.toFixed(2).padStart(7)} │ ${analysis.averageScores.newOverall.toFixed(2).padStart(7)} │ ${(analysis.averageScores.newOverall - analysis.averageScores.oldOverall >= 0 ? "+" : "") + (analysis.averageScores.newOverall - analysis.averageScores.oldOverall).toFixed(2).padStart(9)} │`,
  )
  console.log(`└─────────────────┴─────────┴─────────┴────────────┘`)

  // Comparison statistics
  console.log(`\n🏆 COMPARISON RESULTS:`)
  console.log(
    `┌─────────────────┬─────────┬─────────┬──────┬──────────┬──────────┐`,
  )
  console.log(
    `│ Category        │ Old Win │ New Win │ Ties │ Old Win% │ New Win% │`,
  )
  console.log(
    `├─────────────────┼─────────┼─────────┼──────┼──────────┼──────────┤`,
  )
  console.log(
    `│ Overall         │ ${analysis.comparisonStats.oldWins.toString().padStart(7)} │ ${analysis.comparisonStats.newWins.toString().padStart(7)} │ ${analysis.comparisonStats.ties.toString().padStart(4)} │ ${((analysis.comparisonStats.oldWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │ ${((analysis.comparisonStats.newWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │`,
  )
  console.log(
    `│ Factuality      │ ${analysis.comparisonStats.factualityOldWins.toString().padStart(7)} │ ${analysis.comparisonStats.factualityNewWins.toString().padStart(7)} │ ${analysis.comparisonStats.factualityTies.toString().padStart(4)} │ ${((analysis.comparisonStats.factualityOldWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │ ${((analysis.comparisonStats.factualityNewWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │`,
  )
  console.log(
    `│ Completeness    │ ${analysis.comparisonStats.completenessOldWins.toString().padStart(7)} │ ${analysis.comparisonStats.completenessNewWins.toString().padStart(7)} │ ${analysis.comparisonStats.completenessTies.toString().padStart(4)} │ ${((analysis.comparisonStats.completenessOldWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │ ${((analysis.comparisonStats.completenessNewWins / analysis.validQueries) * 100).toFixed(1).padStart(7)}% │`,
  )
  console.log(
    `└─────────────────┴─────────┴─────────┴──────┴──────────┴──────────┘`,
  )

  // Performance insights
  console.log(`\n🔍 PERFORMANCE INSIGHTS:`)

  const factualityImprovement =
    analysis.averageScores.newFactuality - analysis.averageScores.oldFactuality
  const completenessImprovement =
    analysis.averageScores.newCompleteness -
    analysis.averageScores.oldCompleteness
  const overallImprovement =
    analysis.averageScores.newOverall - analysis.averageScores.oldOverall

  if (factualityImprovement > 0.1) {
    console.log(
      `✅ Factuality improved by ${factualityImprovement.toFixed(2)} points (${((factualityImprovement / analysis.averageScores.oldFactuality) * 100).toFixed(1)}% improvement)`,
    )
  } else if (factualityImprovement < -0.1) {
    console.log(
      `❌ Factuality decreased by ${Math.abs(factualityImprovement).toFixed(2)} points (${((Math.abs(factualityImprovement) / analysis.averageScores.oldFactuality) * 100).toFixed(1)}% decrease)`,
    )
  } else {
    console.log(
      `➖ Factuality remained relatively stable (${factualityImprovement >= 0 ? "+" : ""}${factualityImprovement.toFixed(2)} points)`,
    )
  }

  if (completenessImprovement > 0.1) {
    console.log(
      `✅ Completeness improved by ${completenessImprovement.toFixed(2)} points (${((completenessImprovement / analysis.averageScores.oldCompleteness) * 100).toFixed(1)}% improvement)`,
    )
  } else if (completenessImprovement < -0.1) {
    console.log(
      `❌ Completeness decreased by ${Math.abs(completenessImprovement).toFixed(2)} points (${((Math.abs(completenessImprovement) / analysis.averageScores.oldCompleteness) * 100).toFixed(1)}% decrease)`,
    )
  } else {
    console.log(
      `➖ Completeness remained relatively stable (${completenessImprovement >= 0 ? "+" : ""}${completenessImprovement.toFixed(2)} points)`,
    )
  }

  if (overallImprovement > 0.1) {
    console.log(
      `🎉 Overall performance improved by ${overallImprovement.toFixed(2)} points (${((overallImprovement / analysis.averageScores.oldOverall) * 100).toFixed(1)}% improvement)`,
    )
  } else if (overallImprovement < -0.1) {
    console.log(
      `⚠️  Overall performance decreased by ${Math.abs(overallImprovement).toFixed(2)} points (${((Math.abs(overallImprovement) / analysis.averageScores.oldOverall) * 100).toFixed(1)}% decrease)`,
    )
  } else {
    console.log(
      `📊 Overall performance remained relatively stable (${overallImprovement >= 0 ? "+" : ""}${overallImprovement.toFixed(2)} points)`,
    )
  }

  // Top and bottom performers
  console.log(`\n🏆 TOP 5 QUERIES WHERE NEW ANSWERS EXCELLED:`)
  const topNewWinners = analysis.perQueryAnalysis
    .filter((q) => q.winner === "new")
    .sort((a, b) => b.scoreDifferences.overall - a.scoreDifferences.overall)
    .slice(0, 5)

  if (topNewWinners.length > 0) {
    topNewWinners.forEach((query, index) => {
      console.log(`${index + 1}. Q${query.questionId}: ${query.question}`)
      console.log(
        `   Old: F=${query.oldScores.factuality}, C=${query.oldScores.completeness}, Avg=${query.oldScores.overall.toFixed(1)}`,
      )
      console.log(
        `   New: F=${query.newScores.factuality}, C=${query.newScores.completeness}, Avg=${query.newScores.overall.toFixed(1)} (+${query.scoreDifferences.overall.toFixed(1)})`,
      )
    })
  } else {
    console.log(
      `   No queries where new answers significantly outperformed old answers.`,
    )
  }

  console.log(`\n📉 TOP 5 QUERIES WHERE OLD ANSWERS EXCELLED:`)
  const topOldWinners = analysis.perQueryAnalysis
    .filter((q) => q.winner === "old")
    .sort((a, b) => a.scoreDifferences.overall - b.scoreDifferences.overall)
    .slice(0, 5)

  if (topOldWinners.length > 0) {
    topOldWinners.forEach((query, index) => {
      console.log(`${index + 1}. Q${query.questionId}: ${query.question}`)
      console.log(
        `   Old: F=${query.oldScores.factuality}, C=${query.oldScores.completeness}, Avg=${query.oldScores.overall.toFixed(1)}`,
      )
      console.log(
        `   New: F=${query.newScores.factuality}, C=${query.newScores.completeness}, Avg=${query.newScores.overall.toFixed(1)} (${query.scoreDifferences.overall.toFixed(1)})`,
      )
    })
  } else {
    console.log(
      `   No queries where old answers significantly outperformed new answers.`,
    )
  }

  // Individual Query Scores
  console.log(`\n📋 INDIVIDUAL QUERY SCORES:`)
  console.log(
    `┌────────┬─────────────────────────────────────────────────┬─────────────┬─────────────┐`,
  )
  console.log(
    `│ Query  │ Question                                        │ Old Scores  │ New Scores  │`,
  )
  console.log(
    `├────────┼─────────────────────────────────────────────────┼─────────────┼─────────────┤`,
  )

  analysis.perQueryAnalysis.forEach((query, index) => {
    const questionText =
      query.question.length > 47
        ? query.question.substring(0, 44) + "..."
        : query.question.padEnd(47)
    const oldScoreText =
      `F:${query.oldScores.factuality} C:${query.oldScores.completeness}`.padEnd(
        11,
      )
    const newScoreText =
      `F:${query.newScores.factuality} C:${query.newScores.completeness}`.padEnd(
        11,
      )
    console.log(
      `│ ${query.questionId.toString().padStart(6)} │ ${questionText} │ ${oldScoreText} │ ${newScoreText} │`,
    )
  })

  console.log(
    `└────────┴─────────────────────────────────────────────────┴─────────────┴─────────────┘`,
  )

  console.log(
    `\n═══════════════════════════════════════════════════════════════`,
  )
  console.log(`📊 End of Detailed Score Analysis Report`)
}

// Save detailed score analysis to JSON file
async function saveScoreAnalysis(
  analysis: ScoreAnalysis,
  filePath: string,
): Promise<void> {
  try {
    console.log(`💾 Saving detailed analysis to: ${filePath}`)

    const analysisOutput = {
      metadata: {
        generated_at: new Date().toISOString(),
        total_queries: analysis.totalQueries,
        valid_queries: analysis.validQueries,
        analysis_type: "old_vs_new_agentic_answers_comparison",
      },
      summary: {
        average_scores: analysis.averageScores,
        comparison_statistics: analysis.comparisonStats,
        performance_insights: {
          factuality_change:
            analysis.averageScores.newFactuality -
            analysis.averageScores.oldFactuality,
          completeness_change:
            analysis.averageScores.newCompleteness -
            analysis.averageScores.oldCompleteness,
          overall_change:
            analysis.averageScores.newOverall -
            analysis.averageScores.oldOverall,
          factuality_improvement_percentage:
            analysis.averageScores.oldFactuality > 0
              ? ((analysis.averageScores.newFactuality -
                  analysis.averageScores.oldFactuality) /
                  analysis.averageScores.oldFactuality) *
                100
              : 0,
          completeness_improvement_percentage:
            analysis.averageScores.oldCompleteness > 0
              ? ((analysis.averageScores.newCompleteness -
                  analysis.averageScores.oldCompleteness) /
                  analysis.averageScores.oldCompleteness) *
                100
              : 0,
          overall_improvement_percentage:
            analysis.averageScores.oldOverall > 0
              ? ((analysis.averageScores.newOverall -
                  analysis.averageScores.oldOverall) /
                  analysis.averageScores.oldOverall) *
                100
              : 0,
        },
      },
      per_query_analysis: analysis.perQueryAnalysis,
      top_performers: {
        new_answer_wins: analysis.perQueryAnalysis
          .filter((q) => q.winner === "new")
          .sort(
            (a, b) => b.scoreDifferences.overall - a.scoreDifferences.overall,
          )
          .slice(0, 10),
        old_answer_wins: analysis.perQueryAnalysis
          .filter((q) => q.winner === "old")
          .sort(
            (a, b) => a.scoreDifferences.overall - b.scoreDifferences.overall,
          )
          .slice(0, 10),
        tied_answers: analysis.perQueryAnalysis
          .filter((q) => q.winner === "tie")
          .sort(
            (a, b) =>
              Math.abs(b.scoreDifferences.overall) -
              Math.abs(a.scoreDifferences.overall),
          )
          .slice(0, 10),
      },
    }

    const content = JSON.stringify(analysisOutput, null, 2)
    await fs.writeFile(filePath, content, "utf-8")
    console.log(`✅ Detailed analysis saved successfully to: ${filePath}`)
    console.log(
      `📊 Analysis includes ${analysis.perQueryAnalysis.length} individual query comparisons`,
    )
  } catch (error) {
    console.error(`❌ Error saving detailed analysis:`, error)
    throw error
  }
}

// Main comparison scoring function
export async function scoreComparisonFile(
  oldEvalFilePath: string = DEFAULT_OLD_EVAL_FILE,
  newEvalFilePath: string = DEFAULT_NEW_EVAL_FILE,
  outputFilePath: string = DEFAULT_OUTPUT_FILE,
): Promise<void> {
  console.log(`🚀 Starting comparison evaluation scoring process...`)
  console.log(`📁 Old eval file: ${oldEvalFilePath}`)
  console.log(`📁 New eval file: ${newEvalFilePath}`)
  console.log(`📁 Output file: ${outputFilePath}`)

  try {
    // Read both input files
    console.log(`📖 Reading old eval file: ${oldEvalFilePath}`)
    const oldFileContent = await fs.readFile(oldEvalFilePath, "utf-8")
    console.log(
      `✅ Old file read successfully, size: ${oldFileContent.length} bytes`,
    )

    console.log(`📖 Reading new eval file: ${newEvalFilePath}`)
    const newFileContent = await fs.readFile(newEvalFilePath, "utf-8")
    console.log(
      `✅ New file read successfully, size: ${newFileContent.length} bytes`,
    )

    // Parse JSON files
    console.log(`🔍 Parsing old eval JSON content...`)
    const oldParsedData = JSON.parse(oldFileContent)
    console.log(`✅ Old JSON parsed successfully`)

    console.log(`🔍 Parsing new eval JSON content...`)
    const newParsedData = JSON.parse(newFileContent)
    console.log(`✅ New JSON parsed successfully`)

    // Extract data arrays (both files should be direct arrays)
    let oldEvalData: any[]
    let newEvalData: any[]

    if (Array.isArray(oldParsedData)) {
      oldEvalData = oldParsedData
    } else if (oldParsedData.results && Array.isArray(oldParsedData.results)) {
      oldEvalData = oldParsedData.results
    } else {
      throw new Error(
        "Old agentic answers file does not contain a valid array or results array",
      )
    }

    if (Array.isArray(newParsedData)) {
      newEvalData = newParsedData
    } else if (newParsedData.results && Array.isArray(newParsedData.results)) {
      newEvalData = newParsedData.results
    } else {
      throw new Error(
        "New agentic answers file does not contain a valid array or results array",
      )
    }

    console.log(`📊 Old agentic data: ${oldEvalData.length} items`)
    console.log(`📊 New agentic data: ${newEvalData.length} items`)

    // Match items by Question field and create comparison items
    const comparisonItems: ComparisonEvaluationItem[] = []

    for (let i = 0; i < newEvalData.length; i++) {
      const newItem = newEvalData[i]
      const matchingOldItem = oldEvalData.find(
        (oldItem) => oldItem.Question === newItem.Question,
      )

      if (matchingOldItem) {
        const comparisonItem: ComparisonEvaluationItem = {
          User_data: newItem.User_data,
          Question_weights: newItem.Question_weights,
          Question: newItem.Question,
          Answer_weights: newItem.Answer_weights,
          Answer: newItem.Answer, // Ground truth
          Confidence: newItem.Confidence,
          old_Agentic_answer: matchingOldItem.Agentic_answer,
          new_Agentic_answer: newItem.Agentic_answer,
        }
        comparisonItems.push(comparisonItem)
      } else {
        console.warn(
          `⚠️  No matching old item found for question: ${newItem.Question?.substring(0, 100)}...`,
        )
      }
    }

    console.log(`📊 Created ${comparisonItems.length} comparison items`)

    if (comparisonItems.length === 0) {
      throw new Error(
        "No matching questions found between old and new agentic files",
      )
    }

    // Initialize output file with empty results array
    await fs.writeFile(outputFilePath, '{"results": []}', "utf-8")
    console.log(`📝 Initialized output file: ${outputFilePath}`)

    // Process in batches of 2 for comparison (smaller batches for better JSON parsing)
    const batchSize = 2
    const totalBatches = Math.ceil(comparisonItems.length / batchSize)
    console.log(
      `📦 Processing ${comparisonItems.length} items in ${totalBatches} batches of ${batchSize}...`,
    )

    const allScoredResults: ScoredComparisonItem[] = []

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * batchSize
      const endIndex = Math.min(startIndex + batchSize, comparisonItems.length)
      const batch = comparisonItems.slice(startIndex, endIndex)

      console.log(
        `\n📦 Processing batch ${batchIndex + 1}/${totalBatches} (items ${startIndex + 1}-${endIndex})`,
      )

      const batchResults = await processComparisonBatch(batch, batchIndex + 1)
      allScoredResults.push(...batchResults)

      // Save intermediate results after each batch
      const intermediateOutput = {
        results: allScoredResults,
      }

      console.log(`💾 Saving intermediate results to: ${outputFilePath}`)
      const intermediateContent = JSON.stringify(intermediateOutput, null, 2)
      await fs.writeFile(outputFilePath, intermediateContent, "utf-8")
      console.log(`✅ Saved ${allScoredResults.length} results so far`)

      // Brief pause between batches
      if (batchIndex < totalBatches - 1) {
        console.log(`⏳ Brief pause before next batch...`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    console.log(
      `\n📊 All batches processed. Total comparison items: ${allScoredResults.length}`,
    )

    // Calculate final summary statistics for the output file
    const finalScoreAnalysis = calculateDetailedScoreAnalysis(allScoredResults)

    // Final save with comprehensive summary
    const finalOutput = {
      metadata: {
        generated_at: new Date().toISOString(),
        total_queries: allScoredResults.length,
        analysis_type: "old_vs_new_agentic_answers_comparison",
        scoring_criteria: ["Factuality", "Completeness"],
        model_used: OPENAI_MODEL,
      },
      summary_statistics: {
        average_scores: finalScoreAnalysis.averageScores,
        comparison_results: finalScoreAnalysis.comparisonStats,
        performance_insights: {
          factuality_change:
            finalScoreAnalysis.averageScores.newFactuality -
            finalScoreAnalysis.averageScores.oldFactuality,
          completeness_change:
            finalScoreAnalysis.averageScores.newCompleteness -
            finalScoreAnalysis.averageScores.oldCompleteness,
          overall_change:
            finalScoreAnalysis.averageScores.newOverall -
            finalScoreAnalysis.averageScores.oldOverall,
          overall_improvement_percentage:
            finalScoreAnalysis.averageScores.oldOverall > 0
              ? ((finalScoreAnalysis.averageScores.newOverall -
                  finalScoreAnalysis.averageScores.oldOverall) /
                  finalScoreAnalysis.averageScores.oldOverall) *
                100
              : 0,
        },
        final_overall_scores: {
          overall_score_old: finalScoreAnalysis.averageScores.oldOverall,
          overall_score_new: finalScoreAnalysis.averageScores.newOverall,
        },
      },
      results: allScoredResults,
    }

    console.log(
      `💾 Saving final results with comprehensive summary to: ${outputFilePath}`,
    )
    const outputContent = JSON.stringify(finalOutput, null, 2)
    await fs.writeFile(outputFilePath, outputContent, "utf-8")
    console.log(`✅ Final results saved successfully with summary statistics!`)

    // Print summary statistics
    console.log(`\n📈 COMPARISON SUMMARY:`)
    console.log(`📊 Total items processed: ${allScoredResults.length}`)

    // Calculate comparison statistics
    let oldWins = 0,
      newWins = 0,
      ties = 0
    let factualityOldWins = 0,
      factualityNewWins = 0,
      factualityTies = 0
    let completenessOldWins = 0,
      completenessNewWins = 0,
      completenessTies = 0

    let totalOldFactuality = 0,
      totalNewFactuality = 0
    let totalOldCompleteness = 0,
      totalNewCompleteness = 0
    let totalOldOverall = 0,
      totalNewOverall = 0
    let validScoreCount = 0

    for (const item of allScoredResults) {
      if (item.old_score && item.new_score && item.comparison) {
        // Overall comparison stats
        switch (item.comparison.better_answer) {
          case "old":
            oldWins++
            break
          case "new":
            newWins++
            break
          case "tie":
            ties++
            break
        }

        // Factuality comparison stats based on individual scores
        if (item.old_score.Factuality > item.new_score.Factuality) {
          factualityOldWins++
        } else if (item.new_score.Factuality > item.old_score.Factuality) {
          factualityNewWins++
        } else {
          factualityTies++
        }

        // Completeness comparison stats based on individual scores
        if (item.old_score.Completeness > item.new_score.Completeness) {
          completenessOldWins++
        } else if (item.new_score.Completeness > item.old_score.Completeness) {
          completenessNewWins++
        } else {
          completenessTies++
        }

        // Average scores
        totalOldFactuality += item.old_score.Factuality
        totalNewFactuality += item.new_score.Factuality
        totalOldCompleteness += item.old_score.Completeness
        totalNewCompleteness += item.new_score.Completeness
        totalOldOverall += item.old_score.Overall_Score
        totalNewOverall += item.new_score.Overall_Score
        validScoreCount++
      }
    }

    if (validScoreCount > 0) {
      console.log(`\n🏆 OVERALL COMPARISON RESULTS:`)
      console.log(
        `📈 Old Answer Wins: ${oldWins} (${((oldWins / validScoreCount) * 100).toFixed(1)}%)`,
      )
      console.log(
        `📈 New Answer Wins: ${newWins} (${((newWins / validScoreCount) * 100).toFixed(1)}%)`,
      )
      console.log(
        `📈 Ties: ${ties} (${((ties / validScoreCount) * 100).toFixed(1)}%)`,
      )

      console.log(`\n📊 FACTUALITY COMPARISON:`)
      console.log(
        `📈 Old Wins: ${factualityOldWins}, New Wins: ${factualityNewWins}, Ties: ${factualityTies}`,
      )
      console.log(
        `📊 Average Old Factuality: ${(totalOldFactuality / validScoreCount).toFixed(2)}`,
      )
      console.log(
        `📊 Average New Factuality: ${(totalNewFactuality / validScoreCount).toFixed(2)}`,
      )

      console.log(`\n📊 COMPLETENESS COMPARISON:`)
      console.log(
        `📈 Old Wins: ${completenessOldWins}, New Wins: ${completenessNewWins}, Ties: ${completenessTies}`,
      )
      console.log(
        `📊 Average Old Completeness: ${(totalOldCompleteness / validScoreCount).toFixed(2)}`,
      )
      console.log(
        `📊 Average New Completeness: ${(totalNewCompleteness / validScoreCount).toFixed(2)}`,
      )

      console.log(`\n📊 OVERALL SCORE COMPARISON:`)
      console.log(
        `📊 Average Old Overall Score: ${(totalOldOverall / validScoreCount).toFixed(2)}`,
      )
      console.log(
        `📊 Average New Overall Score: ${(totalNewOverall / validScoreCount).toFixed(2)}`,
      )
      console.log(
        `📊 Overall Score Improvement: ${(totalNewOverall / validScoreCount - totalOldOverall / validScoreCount).toFixed(2)}`,
      )

      // Final Overall Scores Summary
      console.log(`\n🎯 FINAL OVERALL SCORES SUMMARY:`)
      console.log(
        `📈 Overall_Score_Old: ${(totalOldOverall / validScoreCount).toFixed(2)}`,
      )
      console.log(
        `📈 Overall_Score_New: ${(totalNewOverall / validScoreCount).toFixed(2)}`,
      )
    } else {
      console.log(`⚠️  No valid scores found for statistics calculation`)
    }

    // Calculate and display detailed score analysis
    const scoreAnalysis = calculateDetailedScoreAnalysis(allScoredResults)
    displayScoreAnalysis(scoreAnalysis)

    // Save detailed analysis to file
    const analysisFilePath = outputFilePath.replace(".json", "_analysis.json")
    await saveScoreAnalysis(scoreAnalysis, analysisFilePath)

    // Display final overall scores at the end
    console.log(`\n🏁 FINAL RESULTS:`)
    console.log(
      `📊 Overall_Score_Old: ${finalScoreAnalysis.averageScores.oldOverall.toFixed(2)}`,
    )
    console.log(
      `📊 Overall_Score_New: ${finalScoreAnalysis.averageScores.newOverall.toFixed(2)}`,
    )
    console.log(
      `📊 Score Difference: ${(finalScoreAnalysis.averageScores.newOverall - finalScoreAnalysis.averageScores.oldOverall >= 0 ? "+" : "") + (finalScoreAnalysis.averageScores.newOverall - finalScoreAnalysis.averageScores.oldOverall).toFixed(2)}`,
    )

    console.log(`\n🎉 Comparison scoring process completed successfully!`)
  } catch (error) {
    console.error(`❌ Error in comparison scoring process:`, error)
    throw error
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
🔄 Comparison Scorer - Compare Old vs New Agentic Answers

Usage: bun run comparison_scorer.ts [oldEvalFile] [newEvalFile] [outputFile]

Arguments:
  oldEvalFile   Path to the old agentic answers JSON file (default: ${DEFAULT_OLD_EVAL_FILE})
  newEvalFile   Path to the new agentic answers JSON file (default: ${DEFAULT_NEW_EVAL_FILE})  
  outputFile    Path to the output JSON file (default: ${DEFAULT_OUTPUT_FILE})

Options:
  --help, -h    Show this help message

Example:
  bun run comparison_scorer.ts api_agentic_answers.json tool_revamp_agentic.json comparison_results.json

This tool will:
1. Read both agentic answer files (old vs new)
2. Match questions between old and new answers
3. Score both answers using Factuality and Completeness (with question alignment considered within these factors)
4. Compare the answers and determine which is better
5. Save detailed comparison results with comprehensive summary statistics

The output will include:
- Individual scores for old and new answers with overall scores
- Comparison analysis determining which answer is better
- Detailed insights about differences between answers
- Summary statistics about overall performance
- All results saved directly in the output file for further analysis
        `)
    return
  }

  // Use provided arguments or defaults
  const oldEvalFile = args[0] || DEFAULT_OLD_EVAL_FILE
  const newEvalFile = args[1] || DEFAULT_NEW_EVAL_FILE
  const outputFile = args[2] || DEFAULT_OUTPUT_FILE

  console.log(`🎯 Using old agentic file: ${oldEvalFile}`)
  console.log(`🎯 Using new agentic file: ${newEvalFile}`)
  console.log(`🎯 Using output file: ${outputFile}`)

  try {
    await scoreComparisonFile(oldEvalFile, newEvalFile, outputFile)
  } catch (error) {
    console.error(`❌ Comparison scoring failed:`, error)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main()
}
