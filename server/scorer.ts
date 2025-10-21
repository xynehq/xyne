import * as dotenv from "dotenv"
import * as fs from "fs/promises"
import * as path from "path"

// Load environment variables
dotenv.config({ path: "../../server/.env" })

// Configuration for OSS 120B endpoint
const BASE_URL = "https://veronica.pratikn.com"
const OPENAI_API_KEY = "sk-HrawW9WcLJh4125CkMfvwg"
const OPENAI_MODEL = "azure_ai/gpt-oss-120b"

// Default input and output file paths
const DEFAULT_INPUT_FILE =
  "/Users/telkar.varasree/Downloads/xyne/server/agentic_answers_flipkart_new.json"
const DEFAULT_OUTPUT_FILE =
  "/Users/telkar.varasree/Desktop/xyne/server/agentic_answers_eval_tool_revamp_2.json"

// Simple logger replacement
const Logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
}

// Interface for the input JSON structure
interface EvaluationItem {
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
  Answer: string
  Confidence: number
  citations?: string[]
  Agentic_answer: string
}

// Interface for the output with scores
interface ScoredEvaluationItem extends EvaluationItem {
  new_score: {
    Factuality: number
    Completeness: number
    Overall_Score: number
    Reason: string
    Insights?: string
  }
}

function createComparisonScoringPrompt(batch: EvaluationItem[]): string {
  const promptText = `You are an EXPERT  EVALUATION SYSTEM designed to score agentic answer quality for Retrieval-Augmented Generation (RAG) systems. Your task is to evaluate answers (Agentic_answer) against ground truth (Answer) and provide precise comparative analysis.

CORE EVALUATION PRINCIPLES:

Objectivity First: Base scores on observable evidence, not assumptions

Consistency: Apply the same standards across all evaluations

Granularity & Differentiation: Use the full 1-10 scale with high sensitivity to differences. Score comparatively—compare agentic answer directly against the ground truth simultaneously, not independently. Small differences in factual precision, relevance, or completeness must result in noticeable score differences (≥1 point difference). Avoid clustering around middle values or assigning similar scores unless both are equally strong.

Evidence-Based: Every score must be justified with specific examples

SCORING CRITERIA:
CRITICAL: First verify that the answer actually addresses the specific question asked. Then evaluate factuality and completeness.

Factuality (1-10):

__Definition:__ Correctness and accuracy of information when compared to ground truth. Focus on identifying contradictions, verifying claims, and assessing information accuracy.

__Critical Evaluation Process:__

__Step 1: Identify Overlapping Topics__

- List all topics/facts mentioned in BOTH ground truth and agentic_answer
- These are your comparison points

__Step 2: Check for Contradictions__

- For each overlapping topic, verify if the information matches
- A contradiction = any factual claim that directly opposes ground truth
- Minor wording differences are NOT contradictions if meaning is preserved

__Step 3: Assess Additional Information__

- Information in agentic_answer NOT in ground truth: Neutral (doesn't affect score unless contradictory)
- Information in ground truth NOT in agentic_answer: Affects Completeness, not Factuality

__Detailed Scoring Rubric:__

__Score 10 (Perfect Factuality):__

- Zero contradictions with ground truth
- All overlapping information is accurate
- Any additional information (beyond ground truth) is verifiable and correct
- Example: Ground truth says "latency was 450ms" → Agentic answer says "latency reached 450ms" ✓

__Score 7-9 (High Factuality):__

- No direct contradictions
- Minor deviations in presentation but same core facts
- Slight differences in numerical precision that don't change meaning
- Example: Ground truth says "approximately 1,200 transactions" → Agentic answer says "around 1,200 transactions" ✓

__Score 4-6 (Moderate Factuality):__

- Mix of accurate and inaccurate information
- Some contradictions on secondary points
- Core facts correct but supporting details may be wrong
- Example: Correct error code but wrong timestamp or wrong person who reported it

__Score 1-3 (Poor Factuality):__

- Significant factual errors
- Direct contradictions on core information
- Misattributes actions, misquotes numbers, or fabricates details
- Example: Ground truth says "JIRA PAY-1234" → Agentic answer says "JIRA PAY-5678" ✗

__Special Cases:__

__Case A: Agentic answer has MORE detail than ground truth__

- If additional details don't contradict ground truth → Score based on accuracy of overlapping info
- Don't penalize for being more comprehensive

__Case B: Different but equivalent information__

- "OAuth token refresh failed" vs "Authentication token renewal error" → Same meaning, no penalty
- Focus on semantic equivalence, not exact wording

__Case C: Partial information__

- Ground truth: "Error codes U30, U39, and U68"
- Agentic answer: "Error codes U30 and U39"
- This is incomplete (affects Completeness score) but not inaccurate (Factuality remains high)

---
Completeness (1-10):

__Definition:__ How thoroughly the answer addresses all aspects of the question compared to the ground truth.

__Detailed Scoring Rubric:__

__Score 10 (Fully Complete):__

- Addresses every element mentioned in ground truth
- Covers all sub-questions or multi-part aspects
- No significant omissions
- Example: Question asks for "root cause, impact, and solution" → Answer provides all three

__Score 7-9 (Mostly Complete):__

- Covers all major points
- Minor gaps in supporting details
- May lack some examples or specifics present in ground truth
- Example: Provides root cause and solution but less detail on impact

__Score 4-6 (Partially Complete):__

- Addresses main question but misses important elements
- Significant gaps in coverage
- May focus on one aspect while neglecting others
- Example: Multi-part question answered only partially

__Score 1-3 (Incomplete):__

- Major gaps in addressing the question
- Superficial treatment of complex topics
- Misses most sub-questions or key elements
- Example: Question asks for list of 5 items, answer provides only 1-2

COMPARISON ANALYSIS:
After scoring, perform detailed analysis:

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
"new_Agentic_answer": "...",
"new_score": {
"Factuality": X,
"Completeness": Y,
"Overall_Score": Z,
"Reason": "Factuality scored X because [observation]. Completeness scored Y because [observation]. Overall_Score is Z (average of Factuality and Completeness).",
"Insights": "MISSING TRUTH: ... CONTRADICTIONS: ... DEVIATIONS: ... ADDITIONAL CONTEXT: ... OVERALL: ..."
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

"new_Agentic_answer" is the answer to evaluate

Score answer against the ground truth using Factuality and Completeness (with question alignment considered within these factors), then provide  analysis.`

  return promptText
}

// Call OSS 120B LLM with prompt for scoring
async function callLLMForScoring(
  prompt: string,
  batchNumber: number,
  batch: EvaluationItem[],
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

      // Save LLM output for debugging
      try {
        const outputDir = path.join(path.dirname(__filename), "scoring_outputs")
        await fs.mkdir(outputDir, { recursive: true })
        const outputFile = path.join(
          outputDir,
          `batch_${batchNumber}_scoring.txt`,
        )
        await fs.writeFile(outputFile, content, "utf-8")
        console.log(`💾 LLM scoring output saved to: ${outputFile}`)
      } catch (saveError) {
        console.warn(
          `⚠️  Failed to save LLM scoring output for batch ${batchNumber}:`,
          saveError,
        )
      }

      // Enhanced JSON parsing logic
      let parsedContent
      try {
        let cleanContent = content.trim()

        if (cleanContent.startsWith("{") || cleanContent.startsWith("[")) {
          console.log(`🔍 Content appears to be direct JSON`)
        } else {
          const codeBlockPatterns = [
            /```json([\s\S]*?)```/,
            /```plaintext([\s\S]*?)```/,
            /```javascript([\s\S]*?)```/,
            /```([\s\S]*?)```/,
          ]

          let foundCodeBlock = false
          for (const pattern of codeBlockPatterns) {
            const match = content.match(pattern)
            if (match) {
              cleanContent = match[1].trim()
              foundCodeBlock = true
              console.log(`🔍 Found code block with pattern: ${pattern.source}`)
              break
            }
          }

          if (!foundCodeBlock && content.includes("```")) {
            cleanContent = content
              .replace(/```[a-z]*\n?/g, "")
              .replace(/```/g, "")
              .trim()
            console.log(`🔍 Removed all code block markers from content`)
          }

          if (!cleanContent.startsWith("{") && !cleanContent.startsWith("[")) {
            const jsonMatch = content.match(/[{\[][\s\S]*[}\]]/)
            if (jsonMatch) {
              cleanContent = jsonMatch[0]
              console.log(`🔍 Extracted JSON from content`)
            }
          }
        }

        console.log(
          `🔍 Attempting to parse JSON response for batch ${batchNumber}...`,
        )
        console.log(
          `📋 Clean content preview: ${cleanContent.substring(0, 200)}...`,
        )

        parsedContent = JSON.parse(cleanContent)
        console.log(
          `✅ Successfully parsed JSON for batch ${batchNumber} on attempt ${attempt}`,
        )
      } catch (parseError) {
        console.error(
          `❌ JSON parse failed for batch ${batchNumber}:`,
          parseError,
        )
        console.log(`📋 Raw content sample: ${content.substring(0, 500)}...`)

        const patterns = [
          /```json\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/,
          /```plaintext\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/,
          /```javascript\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/,
          /```\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/,
          /(\{[\s\S]*?\}|\[[\s\S]*?\])/,
        ]

        for (const pattern of patterns) {
          try {
            const matches = content.match(pattern)
            if (matches) {
              console.log(`🔍 Trying pattern match for batch ${batchNumber}...`)
              const candidate = Array.isArray(matches)
                ? matches[1] || matches[0]
                : matches[0]
              const parsed = JSON.parse(candidate)
              if (typeof parsed === "object" && parsed !== null) {
                console.log(
                  `✅ Successfully parsed with pattern for batch ${batchNumber}`,
                )
                parsedContent = parsed
                break
              }
            }
          } catch (patternError) {
            continue
          }
        }

        if (!parsedContent) {
          console.error(
            `❌ All JSON parsing attempts failed for batch ${batchNumber}`,
          )
          throw new Error(
            `Failed to parse JSON response for batch ${batchNumber}, attempt ${attempt}: ${parseError}`,
          )
        }
      }

      // Handle different response formats with improved logging
      console.log(
        `🔍 Response structure for batch ${batchNumber}:`,
        Object.keys(parsedContent),
      )

      if (parsedContent.results && Array.isArray(parsedContent.results)) {
        console.log(
          `✅ Parsed structured response for batch ${batchNumber} with ${parsedContent.results.length} results`,
        )
        return parsedContent.results
      } else if (parsedContent["final JSON"]) {
        console.log(`🔍 Found 'final JSON' key for batch ${batchNumber}`)
        const finalJson = parsedContent["final JSON"]
        if (
          finalJson &&
          finalJson.results &&
          Array.isArray(finalJson.results)
        ) {
          console.log(
            `✅ Parsed nested structured response for batch ${batchNumber} with ${finalJson.results.length} results`,
          )
          return finalJson.results
        } else {
          console.log(
            `🔍 'final JSON' structure for batch ${batchNumber}:`,
            Object.keys(finalJson || {}),
          )
        }
      } else if (
        parsedContent.final &&
        typeof parsedContent.final === "string"
      ) {
        console.log(
          `🔍 Found 'final' key with JSON string for batch ${batchNumber}`,
        )
        try {
          const finalParsed = JSON.parse(parsedContent.final)
          if (finalParsed.results && Array.isArray(finalParsed.results)) {
            console.log(
              `✅ Parsed 'final' JSON string response for batch ${batchNumber} with ${finalParsed.results.length} results`,
            )
            return finalParsed.results
          } else if (Array.isArray(finalParsed)) {
            console.log(
              `✅ Parsed 'final' JSON string array response for batch ${batchNumber} with ${finalParsed.length} results`,
            )
            return finalParsed
          } else {
            console.log(
              `🔍 'final' JSON string structure for batch ${batchNumber}:`,
              Object.keys(finalParsed || {}),
            )
          }
        } catch (finalParseError) {
          console.error(
            `❌ Failed to parse 'final' JSON string for batch ${batchNumber}:`,
            finalParseError,
          )
          console.log(
            `📋 Final string sample: ${parsedContent.final.substring(0, 500)}...`,
          )
        }
      } else if (Array.isArray(parsedContent)) {
        console.log(
          `✅ Parsed array response for batch ${batchNumber} with ${parsedContent.length} results`,
        )
        return parsedContent
      } else if (
        parsedContent.commentary &&
        typeof parsedContent.commentary === "string"
      ) {
        console.warn(
          `⚠️  LLM returned commentary instead of results for batch ${batchNumber}: ${parsedContent.commentary}`,
        )
        throw new Error(
          `LLM returned commentary instead of results for batch ${batchNumber}`,
        )
      }

      // If none of the above conditions matched, log detailed structure and throw error
      console.error(`❌ Unexpected response format for batch ${batchNumber}:`)
      console.error(`📋 parsedContent keys:`, Object.keys(parsedContent))
      console.error(`📋 parsedContent type:`, typeof parsedContent)
      console.error(
        `📋 parsedContent sample:`,
        JSON.stringify(parsedContent, null, 2).substring(0, 1000),
      )
      throw new Error(`Unexpected response format for batch ${batchNumber}`)
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

// Calculate average scores from a list of scored items
function calculateAverageScores(scoredItems: ScoredEvaluationItem[]): {
  averageFactuality: number
  averageCompleteness: number
  averageOverallScore: number
  finalScore: number
} {
  if (scoredItems.length === 0) {
    return {
      averageFactuality: 0,
      averageCompleteness: 0,
      averageOverallScore: 0,
      finalScore: 0,
    }
  }

  const avgScores = {
    Factuality: 0,
    Completeness: 0,
  }

  let validScoreCount = 0
  let totalOverallScore = 0

  for (const item of scoredItems) {
    if (item.new_score) {
      avgScores.Factuality += item.new_score.Factuality
      avgScores.Completeness += item.new_score.Completeness
      totalOverallScore += item.new_score.Overall_Score
      validScoreCount++
    }
  }

  if (validScoreCount === 0) {
    return {
      averageFactuality: 0,
      averageCompleteness: 0,
      averageOverallScore: 0,
      finalScore: 0,
    }
  }

  const averageFactuality =
    Math.round((avgScores.Factuality / validScoreCount) * 100) / 100
  const averageCompleteness =
    Math.round((avgScores.Completeness / validScoreCount) * 100) / 100
  const averageOverallScore =
    Math.round((totalOverallScore / validScoreCount) * 10000) / 10000
  const finalScore = Math.round(totalOverallScore * 10000) / 10000

  return {
    averageFactuality,
    averageCompleteness,
    averageOverallScore,
    finalScore,
  }
}

// Process a batch of items for scoring
async function processBatch(
  batch: EvaluationItem[],
  batchNumber: number,
): Promise<ScoredEvaluationItem[]> {
  console.log(
    `📊 Processing batch ${batchNumber} with ${batch.length} items...`,
  )

  try {
    const prompt = createComparisonScoringPrompt(batch)
    console.log(
      `📝 Created scoring prompt for batch ${batchNumber} (length: ${prompt.length} chars)`,
    )

    const scoredResults = await callLLMForScoring(prompt, batchNumber, batch)
    console.log(`✅ Received scoring results for batch ${batchNumber}`)

    if (!Array.isArray(scoredResults)) {
      throw new Error(
        `Expected array response for batch ${batchNumber}, got: ${typeof scoredResults}`,
      )
    }

    const validatedResults: ScoredEvaluationItem[] = []
    for (let i = 0; i < scoredResults.length && i < batch.length; i++) {
      const result = scoredResults[i]
      const originalItem = batch[i]

      if (result.error) {
        console.error(
          `❌ Error in batch ${batchNumber}, item ${i}:`,
          result.error,
        )
        const defaultNewScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1.0,
          Reason: "Error occurred during evaluation after multiple retries",
          Insights: "Unable to evaluate due to processing error",
        }
        validatedResults.push({ ...originalItem, new_score: defaultNewScore })
      } else if (
        result.new_score &&
        typeof result.new_score.Factuality === "number" &&
        typeof result.new_score.Completeness === "number" &&
        typeof result.new_score.Overall_Score === "number"
      ) {
        validatedResults.push(result as ScoredEvaluationItem)
        console.log(`✅ Batch ${batchNumber}, item ${i}: Valid scores received`)
      } else {
        console.warn(
          `⚠️  Batch ${batchNumber}, item ${i}: Invalid score format, using defaults`,
        )
        const defaultNewScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1.0,
          Reason:
            "Default scores applied due to invalid format after multiple retries",
          Insights: "Unable to parse evaluation results",
        }
        validatedResults.push({ ...originalItem, new_score: defaultNewScore })
      }
    }

    console.log(
      `✅ Batch ${batchNumber} processing completed with ${validatedResults.length} valid results`,
    )
    return validatedResults
  } catch (error) {
    console.error(`❌ Error processing batch ${batchNumber}:`, error)

    const defaultScoredBatch: ScoredEvaluationItem[] = batch.map(
      (item, index) => {
        console.log(
          `⚠️  Applying default scores to batch ${batchNumber}, item ${index} due to error`,
        )
        const defaultNewScore = {
          Factuality: 1,
          Completeness: 1,
          Overall_Score: 1.0,
          Reason: "Error occurred during batch processing",
          Insights: "Unable to evaluate due to processing error",
        }
        return { ...item, new_score: defaultNewScore }
      },
    )

    return defaultScoredBatch
  }
}

// Main scoring function with immediate saving
export async function scoreEvaluationFile(
  inputFilePath: string = DEFAULT_INPUT_FILE,
  outputFilePath: string = DEFAULT_OUTPUT_FILE,
): Promise<void> {
  console.log(`🚀 Starting evaluation scoring process...`)
  console.log(`📁 Input file: ${inputFilePath}`)
  console.log(`📁 Output file: ${outputFilePath}`)

  try {
    // Resolve file paths relative to the script location
    const resolvedInputPath = path.resolve(
      path.dirname(__filename),
      inputFilePath,
    )
    const resolvedOutputPath = path.resolve(
      path.dirname(__filename),
      outputFilePath,
    )

    console.log(`📁 Resolved input path: ${resolvedInputPath}`)
    console.log(`📁 Resolved output path: ${resolvedOutputPath}`)

    // Read input file
    console.log(`📖 Reading input file: ${resolvedInputPath}`)
    const fileContent = await fs.readFile(resolvedInputPath, "utf-8")
    console.log(`✅ File read successfully, size: ${fileContent.length} bytes`)

    // Parse JSON
    console.log(`🔍 Parsing JSON content...`)
    const parsedData = JSON.parse(fileContent)
    console.log(`✅ JSON parsed successfully`)

    // Handle different input structures
    let evaluationData: EvaluationItem[]

    if (Array.isArray(parsedData)) {
      // Direct array format
      evaluationData = parsedData
      console.log(`📋 Found direct array with ${evaluationData.length} items`)
    } else if (parsedData.results && Array.isArray(parsedData.results)) {
      // Wrapper object with "results" array
      evaluationData = parsedData.results
      console.log(`📋 Found results array with ${evaluationData.length} items`)
    } else {
      throw new Error(
        'Input file must contain either a JSON array or an object with a "results" array property',
      )
    }

    if (evaluationData.length === 0) {
      throw new Error("Input file contains no evaluation items")
    }

    console.log(
      `📊 Validating input structure for ${evaluationData.length} items...`,
    )

    // Validate each item has required fields
    for (let i = 0; i < evaluationData.length; i++) {
      const item = evaluationData[i]
      if (!item.Question || !item.Answer || !item.Agentic_answer) {
        console.warn(
          `⚠️  Item ${i} missing required fields (Question, Answer, or Agentic_answer)`,
        )
      }
    }

    // Initialize output file with empty array
    await fs.writeFile(resolvedOutputPath, "[]", "utf-8")
    console.log(`📝 Initialized output file: ${resolvedOutputPath}`)

    // Process in batches of 2 for immediate saving
    const batchSize = 2
    const totalBatches = Math.ceil(evaluationData.length / batchSize)
    console.log(
      `📦 Processing ${evaluationData.length} items in ${totalBatches} batches of ${batchSize}...`,
    )

    const allScoredResults: ScoredEvaluationItem[] = []

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * batchSize
      const endIndex = Math.min(startIndex + batchSize, evaluationData.length)
      const batch = evaluationData.slice(startIndex, endIndex)

      console.log(
        `\n🔄 Processing batch ${batchIndex + 1}/${totalBatches} (items ${startIndex + 1}-${endIndex})...`,
      )

      try {
        const scoredBatch = await processBatch(batch, batchIndex + 1)
        allScoredResults.push(...scoredBatch)
        console.log(`✅ Batch ${batchIndex + 1} completed successfully`)

        // Save results immediately after each batch
        console.log(
          `💾 Saving intermediate results after batch ${batchIndex + 1}...`,
        )
        const outputContent = JSON.stringify(allScoredResults, null, 2)
        await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
        console.log(
          `✅ Intermediate results saved! Progress: ${allScoredResults.length}/${evaluationData.length} items`,
        )

        // Brief pause between batches
        if (batchIndex < totalBatches - 1) {
          console.log(`⏳ Brief pause before next batch...`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      } catch (batchError) {
        console.error(`❌ Batch ${batchIndex + 1} failed:`, batchError)

        // Add batch with default scores
        const defaultBatch: ScoredEvaluationItem[] = batch.map((item) => {
          const defaultNewScore = {
            Factuality: 1,
            Completeness: 1,
            Overall_Score: 1.0,
            Reason: "Batch processing failed",
            Insights: "Unable to evaluate due to batch processing error",
          }
          return {
            ...item,
            new_score: defaultNewScore,
          }
        })
        allScoredResults.push(...defaultBatch)
        console.log(
          `⚠️  Added batch ${batchIndex + 1} with default scores due to error`,
        )

        // Save results even for failed batches
        console.log(`💾 Saving results after failed batch ${batchIndex + 1}...`)
        const outputContent = JSON.stringify(allScoredResults, null, 2)
        await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
        console.log(
          `✅ Results saved after error! Progress: ${allScoredResults.length}/${evaluationData.length} items`,
        )
      }
    }

    console.log(
      `\n📊 All batches processed. Total scored items: ${allScoredResults.length}`,
    )

    // Final save
    console.log(`💾 Saving final results to: ${resolvedOutputPath}`)
    const outputContent = JSON.stringify(allScoredResults, null, 2)
    await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
    console.log(`✅ Final results saved successfully!`)

    // Print summary statistics
    console.log(`\n📈 SCORING SUMMARY:`)
    console.log(`📊 Total items processed: ${allScoredResults.length}`)

    // Calculate average scores using the dedicated function
    const {
      averageFactuality,
      averageCompleteness,
      averageOverallScore,
      finalScore,
    } = calculateAverageScores(allScoredResults)

    if (averageFactuality > 0) {
      // Check if any valid scores were processed
      console.log(`📊 Average Scores:`)
      console.log(`   ✅ Factuality: ${averageFactuality}/10`)
      console.log(`    Completeness: ${averageCompleteness}/10`)
      console.log(
        `   🏆 Average Overall Score: ${averageOverallScore} (out of 10)`,
      )
      console.log(
        `   🎯 Final Score (Sum of all overall scores): ${finalScore}`,
      )

      console.log(`\n✅ Evaluation completed successfully for all items`)

      // Add average_score and final_score to the final output
      const finalOutput = {
        results: allScoredResults,
        average_scores: {
          newFactuality: averageFactuality,
          newCompleteness: averageCompleteness,
          newOverall: averageOverallScore,
        },
      }

      // Save final results with summary
      console.log(
        `💾 Saving final results with summary to: ${resolvedOutputPath}`,
      )
      const finalOutputContent = JSON.stringify(finalOutput, null, 2)
      await fs.writeFile(resolvedOutputPath, finalOutputContent, "utf-8")
      console.log(`✅ Final results with summary saved successfully!`)
    } else {
      // If no valid scores, just save the results as before
      console.log(`💾 Saving final results to: ${resolvedOutputPath}`)
      const outputContent = JSON.stringify(allScoredResults, null, 2)
      await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
      console.log(`✅ Final results saved successfully!`)
    }

    console.log(`\n🎉 Scoring process completed successfully!`)
  } catch (error) {
    console.error(`❌ Error in scoring process:`, error)
    throw error
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
🔧 Usage: bun run scorer.ts [input_file.json] [output_file.json]

📝 Description:
   This script evaluates answer quality by scoring Agentic_answer against 
   ground truth Answer on two criteria: Factuality and Completeness using 
   an LLM.
   
   For each query, it calculates:
   - Individual scores (1-10) for Factuality and Completeness
   - overall_score: (Factuality + Completeness) / 2
   - Detailed insights and reasoning for each score

📋 Parameters:
   input_file.json   - JSON file with evaluation items (default: ${DEFAULT_INPUT_FILE})
   output_file.json  - Output file (default: ${DEFAULT_OUTPUT_FILE})

📊 Examples:
   bun run scorer.ts                                    # Use default files
   bun run scorer.ts custom_input.json                  # Custom input, default output
   bun run scorer.ts custom_input.json custom_out.json  # Custom input and output

🔧 Configuration:
   Scoring Method: LLM-based scoring
   Batch Size: 2 items per batch
   Processing Speed: Dependent on LLM API response time
        `)
    process.exit(0)
  }

  // Use provided arguments or defaults
  const inputFile = args[0] || DEFAULT_INPUT_FILE
  const outputFile = args[1] || DEFAULT_OUTPUT_FILE

  console.log(`🎯 Using input file: ${inputFile}`)
  console.log(`🎯 Using output file: ${outputFile}`)

  try {
    await scoreEvaluationFile(inputFile, outputFile)
  } catch (error) {
    console.error(`❌ Scoring failed:`, error)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main()
}
