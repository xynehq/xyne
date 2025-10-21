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
  "/Users/telkar.varasree/Downloads/xyne/server/slack_model_answers.json"
const DEFAULT_OUTPUT_FILE =
  "/Users/telkar.varasree/Downloads/xyne/server/slack_both_eval_2params.json"

// Simple logger replacement
const Logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
}

// Interface for the input JSON structure
interface EvaluationItem {
  question_type: number
  vagueness: number
  question: string
  answer: string
  thread_ids?: string[]
  source_thread_id?: string
  model_answer_non_agentic: string
  model_answer_agentic: string
}

// Interface for the score object
interface Score {
  // DomainRelevance: number;
  Factuality: number
  // SemanticSimilarity: number;
  Completeness: number
  Reason: string
  Insights: string
  Penalty?: number
  PenaltyReason?: string
}

// Interface for the output with scores
interface ScoredEvaluationItem extends EvaluationItem {
  score_agentic?: Score
  score_Non_agentic?: Score
  overall_score_agentic?: number
  overall_score_non_agentic?: number
  score?: Score // Keep for potential backward compatibility
  overall_score?: number // Keep for potential backward compatibility
  error?: string // To store error messages
}

// Helper function to calculate overall score as percentage
function calculateOverallScore(score: {
  // DomainRelevance: number;
  Factuality: number
  // SemanticSimilarity: number;
  Completeness: number
  Penalty?: number // optional field
}): number {
  const sum =
    // score.DomainRelevance +
    score.Factuality +
    // score.SemanticSimilarity +
    score.Completeness

  // average percentage score (0–1 range)
  let result = sum / 20

  // subtract penalty if present
  if (score.Penalty && score.Penalty !== 0) {
    result = result - Math.abs(score.Penalty) / 20
  }

  // round to 4 decimal places
  return Math.round(result * 10000) / 10000
}

// Call OSS 120B LLM with prompt for scoring with enhanced timeout handling
async function callLLMForScoring(
  prompt: string,
  batchNumber: number,
  batch: EvaluationItem[],
  maxRetries = 5,
): Promise<any> {
  console.log(
    `🔧 Starting LLM scoring call for batch ${batchNumber} using model: ${OPENAI_MODEL}`,
  )

  let lastError: any
  const timeoutMs = 120000 // 2 minutes timeout

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🔧 LLM scoring attempt ${attempt}/${maxRetries} for batch ${batchNumber} (timeout: ${timeoutMs}ms)`,
      )

      const requestBody = {
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 12000, // Increased to allow complete responses
      }

      console.log(
        `📤 Sending scoring request to LLM for batch ${batchNumber}...`,
      )

      // Create AbortController for timeout handling
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          Connection: "keep-alive",
          "Keep-Alive": "timeout=120",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        if (response.status === 504) {
          throw new Error(
            `HTTP 504 Gateway Timeout: Server took too long to respond. This might be due to high load or complex processing.`,
          )
        }
        throw new Error(
          `HTTP ${response.status}: ${response.statusText} - ${errorText}`,
        )
      }

      const responseData = await response.json()
      console.log(
        `📥 Received response from LLM for batch ${batchNumber} :`,
        JSON.stringify(responseData),
      )

      if (
        !responseData.choices ||
        !responseData.choices[0] ||
        !responseData.choices[0].message
      ) {
        throw new Error("Invalid response structure from LLM")
      }

      const content = responseData.choices[0].message.content.trim()

      if (!content) {
        throw new Error("No valid LLM output received")
      }

      console.log(
        `✅ LLM scoring call successful for batch ${batchNumber}, content length: ${content.length}`,
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

      // Direct JSON parsing - LLM must provide valid JSON
      console.log(
        `🔍 Attempting to parse LLM response for batch ${batchNumber}...`,
      )
      console.log(
        `📋 Content length: ${content.length}, preview: ${content.substring(0, 200)}...`,
      )

      const parsedResult = JSON.parse(content)

      // Handle both single object and array responses
      if (Array.isArray(parsedResult)) {
        console.log(
          `✅ Successfully parsed LLM JSON array for batch ${batchNumber} (${parsedResult.length} items)`,
        )
        return parsedResult
      } else if (typeof parsedResult === "object" && parsedResult !== null) {
        // LLM returned single object, wrap in array for batch processing
        console.log(
          `🔧 LLM returned single object, wrapping in array for batch ${batchNumber}`,
        )
        const arrayResult =
          batch.length === 1
            ? [parsedResult]
            : batch.map((_, index) => ({ ...parsedResult, item_index: index }))
        console.log(
          `✅ Successfully wrapped single object for batch ${batchNumber} (${arrayResult.length} items)`,
        )
        return arrayResult
      } else {
        throw new Error("LLM response is neither a JSON array nor object")
      }
    } catch (err: any) {
      lastError = err

      // Classify error types for better handling
      let errorType = "UNKNOWN"
      let shouldRetry = true
      let retryDelay = Math.pow(2, attempt) * 1000

      if (err.name === "AbortError" || err.message.includes("aborted")) {
        errorType = "TIMEOUT"
        retryDelay = Math.min(retryDelay * 2, 60000) // Cap at 60 seconds
      } else if (
        err.message.includes("504") ||
        err.message.includes("Gateway Timeout")
      ) {
        errorType = "GATEWAY_TIMEOUT"
        retryDelay = Math.min(retryDelay * 1.5, 45000) // More aggressive retry for 504s
      } else if (
        err.message.includes("503") ||
        err.message.includes("Service Unavailable")
      ) {
        errorType = "SERVICE_UNAVAILABLE"
        retryDelay = Math.min(retryDelay * 2, 30000)
      } else if (
        err.message.includes("429") ||
        err.message.includes("Rate limit")
      ) {
        errorType = "RATE_LIMITED"
        retryDelay = Math.min(retryDelay * 3, 90000) // Longer delay for rate limits
      } else if (
        err.message.includes("JSON") ||
        err.message.includes("parse")
      ) {
        errorType = "JSON_PARSE_ERROR"
        retryDelay = Math.min(retryDelay, 5000) // Shorter delay for JSON errors
      } else if (err.message.includes("Invalid response structure")) {
        errorType = "INVALID_RESPONSE"
        shouldRetry = false // Don't retry structural errors
      }

      console.error(
        `❌ LLM scoring call attempt ${attempt}/${maxRetries} failed for batch ${batchNumber} [${errorType}]:`,
        {
          error: err.message,
          errorType,
          model: OPENAI_MODEL,
          baseUrl: BASE_URL,
          willRetry: attempt < maxRetries && shouldRetry,
        },
      )

      // Enhanced retry logic based on error type
      if (attempt < maxRetries && shouldRetry) {
        const jitter = Math.random() * 1000
        const delay = retryDelay + jitter
        console.log(
          `⏳ Retrying batch ${batchNumber} in ${Math.round(delay)}ms due to ${errorType}...`,
        )
        await new Promise((res) => setTimeout(res, delay))
      } else if (!shouldRetry) {
        console.error(
          `❌ Stopping retries for batch ${batchNumber} due to non-retryable error: ${errorType}`,
        )
        break
      }
    }
  }

  // Create detailed error message based on error type
  const errorMessage = lastError?.message || "Unknown error"
  let detailedError = `LLM scoring call failed for batch ${batchNumber} after ${maxRetries} attempts.`

  if (
    errorMessage.includes("504") ||
    errorMessage.includes("Gateway Timeout")
  ) {
    detailedError += ` Server timeout detected - this may indicate server overload or complex processing requirements.`
  } else if (errorMessage.includes("503")) {
    detailedError += ` Service unavailable - the LLM service may be temporarily down.`
  } else if (errorMessage.includes("429")) {
    detailedError += ` Rate limiting detected - too many requests sent too quickly.`
  } else if (errorMessage.includes("JSON")) {
    detailedError += ` JSON parsing failed - LLM returned malformed response.`
  }

  detailedError += ` Last error: ${errorMessage}`
  throw new Error(detailedError)
}

// Create scoring prompt for a batch of items
function createScoringPrompt(batch: EvaluationItem[]): string {
  return `
You are an expert evaluation system. Your task is to evaluate answers from a RAG system against a ground truth.
For each item in the input JSON array, you must perform two separate evaluations:
1. Evaluate \`model_answer_agentic\` against the ground truth \`answer\`.
2. Evaluate \`model_answer_non_agentic\` against the ground truth \`answer\`.

## __SCORING CRITERIA__

Evaluate each answer pair on these two factors (scale 1-10). Each score must be an integer with clear justification.

### __1. Factuality (1-10)__

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

### __2. Completeness (1-10)__

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

__Evaluation Framework:__

1. List all elements in ground truth answer
2. Check which elements are present in agentic_answer
3. Calculate coverage percentage
4. Assign score based on coverage and importance of missing elements

---

## __REASON FIELD GUIDELINES__

The Reason field must provide a clear, concise explanation (1-2 sentences) of why you assigned those specific scores.

__Structure Template:__ "[Parameter] scored [X] because [specific observation]. [Parameter] scored [Y] because [specific observation]."

__Poor Reason Examples (Avoid These):__

❌ "The answer is good." (Too vague) ❌ "Scores are based on comparison." (Doesn't explain specific reasoning) ❌ "Factuality is 7." (Just restates the score without justification)

__Reason Field Requirements:__

- Must reference specific elements from the answer
- Should mention all 2 parameters being scored
- Keep to 1-2 sentences maximum
- Be specific, not generic

---

## __INSIGHTS FIELD GUIDELINES__

The Insights field provides detailed analysis of gaps, contradictions, deviations, or notable observations. This is where you explain what's missing or different.

__Categories of Insights:__

### __1. Missing Information__

Information present in ground truth but absent in agentic_answer.

__Example:__ "The ground truth mentions three specific JIRA tickets (PAY-1234, PAY-5678, PAY-9012), but the agentic answer only references the general project without specific ticket numbers. Additionally, the ground truth identifies Arjun Mehta as the person who escalated the issue, which is completely omitted from the agentic answer."

### __2. Contradictions__

Direct factual conflicts between ground truth and agentic_answer.

__Example:__ "CONTRADICTION: Ground truth states the latency spike occurred at 2:30 PM IST, while the agentic answer claims it happened at 4:15 PM IST. Additionally, ground truth identifies the root cause as database connection pool exhaustion, but agentic answer attributes it to network timeout issues."

### __3. Deviations__

Information that's similar but not quite the same; nuanced differences.

__Example:__ "DEVIATION: Ground truth specifies 'p99 latency of 850ms' while agentic answer states 'approximately 800ms latency.' While close, this 50ms difference could be significant for SLA compliance. The ground truth also mentions this affected 'high-risk customer segments specifically,' whereas the agentic answer generalizes to 'all customer segments.'"

### __4. Additional Context__

Information in agentic_answer not present in ground truth (note if helpful or irrelevant).

__Example:__ "The agentic answer provides additional context about the broader RBI audit implications and mentions related work IDs (c543f75f-1993-4086-bc57-640bb7c26576), which while not in the ground truth, adds valuable context for understanding the issue's importance."

### __5. Structural Differences__

How information is organized or presented differently.

__Example:__ "The ground truth presents information chronologically (problem → investigation → solution), while the agentic answer uses a categorical structure (technical issues → business impact → remediation). Both contain similar information but the different organization may affect user comprehension."

__Insights Field Template:__

MISSING TRUTH: [List specific facts from ground truth not in agentic answer]

CONTRADICTIONS: [List any direct factual conflicts]

DEVIATIONS: [List nuanced differences or approximations]

ADDITIONAL CONTEXT: [Note any extra information provided]

OVERALL ASSESSMENT: [1-sentence summary of the gap analysis]


__Complete Insights Example:__


MISSING TRUTH: The agentic answer omits the specific error code (E-408: Invalid_Risk_Payload), the affected API endpoint (NPCI/Aadhaar/v3.1/verify), and the 18.5% failure rate mentioned in ground truth.

CONTRADICTIONS: None found - all overlapping information is factually consistent.

DEVIATIONS: Ground truth specifies "users flagged as HIGH_RISK" while agentic answer uses the more general term "high-risk customer segments." The meaning is equivalent but precision differs.

ADDITIONAL CONTEXT: Agentic answer includes information about related JIRA tickets (PAY-5011, PAY-8054) and work IDs not mentioned in ground truth, providing broader project context.

OVERALL ASSESSMENT: The agentic answer captures the general issue but lacks the technical specificity (error codes, endpoints, metrics) that makes the ground truth actionable for engineers.


__When Insights Can Be Brief:__

If the agentic answer is highly accurate and complete: "No significant missing information or contradictions found. The agentic answer comprehensively covers all points from the ground truth with equivalent semantic meaning and factual accuracy."

---


Your output MUST be a valid JSON array. Each object in the array must preserve the original fields and include two new fields: \`score_agentic\` and \`score_Non_agentic\`.

**CRITICAL INSTRUCTIONS:**
1.  **Return ONLY a valid JSON array.** No extra text, markdown, or explanations.
2.  The entire output must start with \`[\` and end with \`]\`.
3.  For each item, add \`score_agentic\` and \`score_Non_agentic\` objects containing the four scores, a \`Reason\` (1-2 sentences), and \`Insights\` (detailed analysis).
4.  All scores must be integers between 1 and 10.

**Example of a single output object:**

{
  "question_type": 1,
  "vagueness": 0.1,
  "question": "What was the outcome of the request to temporarily increase the API refund initiation limit for Curefit from 25 to 30?",
  "answer": "The configuration change was actioned. M L V S Manohar requested approval for the update, and Yashi confirmed that it was approved and released.",
  "source_thread_id": "1744800007.869839",
  "model_answer_non_agentic": "Based on the available context...",
  "model_answer_agentic": "I don't have sufficient information...",
  "score_Non_agentic": {
    "Factuality": 9,
    "Completeness": 8,
    "Reason": "The answer correctly identifies the topic but misses the final confirmation.",
    "Insights": "MISSING TRUTH: The final confirmation of the release is omitted."
  },
  "score_agentic": {
    "Factuality": 10,
    "Completeness": 2,
    "Reason": "The model correctly states it lacks information, which is factual but unhelpful.",
    "Insights": "The model failed to retrieve the necessary information to answer the question."
  }
}


---

__BEGIN EVALUATION NOW__

Input Data: ${JSON.stringify(batch, null, 2)}
`
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
    const prompt = createScoringPrompt(batch)
    console.log(
      `📝 Created scoring prompt for batch ${batchNumber} (length: ${prompt.length} chars)`,
    )

    const scoredResults = await callLLMForScoring(prompt, batchNumber, batch)
    console.log(`✅ Received scoring results for batch ${batchNumber}`)

    // Validate that we got the expected number of results
    if (!Array.isArray(scoredResults)) {
      throw new Error(
        `Expected array response for batch ${batchNumber}, got: ${typeof scoredResults}`,
      )
    }

    if (scoredResults.length !== batch.length) {
      console.warn(
        `⚠️  Batch ${batchNumber}: Expected ${batch.length} results, got ${scoredResults.length}`,
      )
    }

    // Validate each result has the score field
    const validatedResults: ScoredEvaluationItem[] = []
    for (let i = 0; i < scoredResults.length; i++) {
      const result = scoredResults[i]
      const originalItem = batch[i] || batch[0] // Fallback for safety

      if (result.error) {
        console.error(
          `❌ Error in batch ${batchNumber}, item ${i}:`,
          result.error,
        )
        const defaultScore = {
          Factuality: 1,
          Completeness: 1,
          Reason: "Error",
          Insights: result.error,
        }
        validatedResults.push({
          ...originalItem,
          score: defaultScore,
          overall_score: calculateOverallScore(defaultScore),
          error: result.error,
        })
        continue
      }

      let isValid = false
      const scoredItem: ScoredEvaluationItem = { ...originalItem, ...result }

      // Handle new format (agentic/non-agentic)
      if (
        result.score_agentic &&
        typeof result.score_agentic.Factuality === "number"
      ) {
        scoredItem.overall_score_agentic = calculateOverallScore(
          result.score_agentic,
        )
        console.log(
          `✅ Batch ${batchNumber}, item ${i}: Valid agentic score received.`,
        )
        isValid = true
      }

      if (
        result.score_Non_agentic &&
        typeof result.score_Non_agentic.Factuality === "number"
      ) {
        scoredItem.overall_score_non_agentic = calculateOverallScore(
          result.score_Non_agentic,
        )
        console.log(
          `✅ Batch ${batchNumber}, item ${i}: Valid non-agentic score received.`,
        )
        isValid = true
      }

      // Handle old format for backward compatibility
      // if (result.score && typeof result.score.DomainRelevance === 'number') {
      //     scoredItem.overall_score = result.overall_score || calculateOverallScore(result.score);
      //     console.log(`✅ Batch ${batchNumber}, item ${i}: Valid legacy score received.`);
      //     isValid = true;
      // }

      if (isValid) {
        validatedResults.push(scoredItem)
      } else {
        console.warn(
          `⚠️  Batch ${batchNumber}, item ${i}: Invalid or missing score format, using defaults.`,
        )
        const defaultScore = {
          Factuality: 1,
          Completeness: 1,
          Reason: "Invalid format",
          Insights: "LLM returned an invalid score format.",
        }
        validatedResults.push({
          ...originalItem,
          score: defaultScore,
          overall_score: calculateOverallScore(defaultScore),
          error: "Invalid score format from LLM",
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
    const defaultScoredBatch: ScoredEvaluationItem[] = batch.map(
      (item, index) => {
        console.log(
          `⚠️  Applying default scores to batch ${batchNumber}, item ${index} due to error`,
        )
        const defaultScore = {
          Factuality: 1,
          Completeness: 1,
          Reason: "Batch processing error",
          Insights: error instanceof Error ? error.message : "Unknown error",
        }
        return {
          ...item,
          score: defaultScore,
          overall_score: calculateOverallScore(defaultScore),
        }
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
      const item = evaluationData[i] as EvaluationItem
      if (
        !item.question ||
        !item.answer ||
        !item.model_answer_agentic ||
        !item.model_answer_non_agentic
      ) {
        console.warn(
          `⚠️  Item ${i} missing required fields (question, answer, model_answer_agentic, or model_answer_non_agentic)`,
        )
      }
    }

    // Initialize output file with empty array
    await fs.writeFile(resolvedOutputPath, "[]", "utf-8")
    console.log(`📝 Initialized output file: ${resolvedOutputPath}`)

    // Process in batches of 1 to prevent timeouts and ensure reliability
    const batchSize = 2
    const totalBatches = Math.ceil(evaluationData.length / batchSize)
    console.log(
      `📦 Processing ${evaluationData.length} items in ${totalBatches} batches of ${batchSize} (single item per batch to prevent timeouts)...`,
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

        // Add delay between batches to avoid rate limiting
        if (batchIndex < totalBatches - 1) {
          console.log(`⏳ Waiting 3 seconds before next batch...`)
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      } catch (batchError) {
        console.error(`❌ Batch ${batchIndex + 1} failed:`, batchError)

        // Add batch with default scores
        const defaultBatch: ScoredEvaluationItem[] = batch.map((item) => {
          const defaultScore = {
            Factuality: 1,
            Completeness: 1,
            Reason: "Batch processing error",
            Insights:
              batchError instanceof Error
                ? batchError.message
                : "Unknown error",
          }
          return {
            ...item,
            score: defaultScore,
            overall_score: calculateOverallScore(defaultScore),
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

    // Final save is now handled within the summary block

    // Print summary statistics
    console.log(`\n📈 SCORING SUMMARY:`)
    console.log(`📊 Total items processed: ${allScoredResults.length}`)

    const summary = {
      total_items: allScoredResults.length,
      agentic: {
        count: 0,
        avg_overall_score: 0,
        avg_scores: { Factuality: 0, Completeness: 0 },
      },
      non_agentic: {
        count: 0,
        avg_overall_score: 0,
        avg_scores: { Factuality: 0, Completeness: 0 },
      },
      legacy: {
        count: 0,
        avg_overall_score: 0,
        avg_scores: { Factuality: 0, Completeness: 0 },
      },
    }

    for (const item of allScoredResults) {
      if (
        item.score_agentic &&
        typeof item.overall_score_agentic === "number"
      ) {
        summary.agentic.count++
        summary.agentic.avg_overall_score += item.overall_score_agentic
        // summary.agentic.avg_scores.DomainRelevance += item.score_agentic.DomainRelevance;
        summary.agentic.avg_scores.Factuality += item.score_agentic.Factuality
        // summary.agentic.avg_scores.SemanticSimilarity += item.score_agentic.SemanticSimilarity;
        summary.agentic.avg_scores.Completeness +=
          item.score_agentic.Completeness
      }
      if (
        item.score_Non_agentic &&
        typeof item.overall_score_non_agentic === "number"
      ) {
        summary.non_agentic.count++
        summary.non_agentic.avg_overall_score += item.overall_score_non_agentic
        // summary.non_agentic.avg_scores.DomainRelevance += item.score_Non_agentic.DomainRelevance;
        summary.non_agentic.avg_scores.Factuality +=
          item.score_Non_agentic.Factuality
        // summary.non_agentic.avg_scores.SemanticSimilarity += item.score_Non_agentic.SemanticSimilarity;
        summary.non_agentic.avg_scores.Completeness +=
          item.score_Non_agentic.Completeness
      }
      if (item.score && typeof item.overall_score === "number") {
        summary.legacy.count++
        summary.legacy.avg_overall_score += item.overall_score
        // summary.legacy.avg_scores.DomainRelevance += item.score.DomainRelevance;
        summary.legacy.avg_scores.Factuality += item.score.Factuality
        // summary.legacy.avg_scores.SemanticSimilarity += item.score.SemanticSimilarity;
        summary.legacy.avg_scores.Completeness += item.score.Completeness
      }
    }

    const calculateAverages = (data: any) => {
      if (data.count > 0) {
        data.avg_overall_score =
          Math.round((data.avg_overall_score / data.count) * 10000) / 10000
        // data.avg_scores.DomainRelevance = Math.round((data.avg_scores.DomainRelevance / data.count) * 100) / 100;
        data.avg_scores.Factuality =
          Math.round((data.avg_scores.Factuality / data.count) * 100) / 100
        // data.avg_scores.SemanticSimilarity = Math.round((data.avg_scores.SemanticSimilarity / data.count) * 100) / 100;
        data.avg_scores.Completeness =
          Math.round((data.avg_scores.Completeness / data.count) * 100) / 100
      }
    }

    calculateAverages(summary.agentic)
    calculateAverages(summary.non_agentic)
    calculateAverages(summary.legacy)

    if (summary.agentic.count > 0) {
      console.log(
        `\n📊 Agentic Scores Summary (${summary.agentic.count} items):`,
      )
      console.log(
        `   - Average Overall Score: ${summary.agentic.avg_overall_score}`,
      )
      // console.log(`   - Average Domain Relevance: ${summary.agentic.avg_scores.DomainRelevance}/10`);
      console.log(
        `   - Average Factuality: ${summary.agentic.avg_scores.Factuality}/10`,
      )
      // console.log(`   - Average Semantic Similarity: ${summary.agentic.avg_scores.SemanticSimilarity}/10`);
      console.log(
        `   - Average Completeness: ${summary.agentic.avg_scores.Completeness}/10`,
      )
    }
    if (summary.non_agentic.count > 0) {
      console.log(
        `\n📊 Non-Agentic Scores Summary (${summary.non_agentic.count} items):`,
      )
      console.log(
        `   - Average Overall Score: ${summary.non_agentic.avg_overall_score}`,
      )
      // console.log(`   - Average Domain Relevance: ${summary.non_agentic.avg_scores.DomainRelevance}/10`);
      console.log(
        `   - Average Factuality: ${summary.non_agentic.avg_scores.Factuality}/10`,
      )
      // console.log(`   - Average Semantic Similarity: ${summary.non_agentic.avg_scores.SemanticSimilarity}/10`);
      console.log(
        `   - Average Completeness: ${summary.non_agentic.avg_scores.Completeness}/10`,
      )
    }
    if (summary.legacy.count > 0) {
      console.log(`\n📊 Legacy Scores Summary (${summary.legacy.count} items):`)
      console.log(
        `   - Average Overall Score: ${summary.legacy.avg_overall_score}`,
      )
      // console.log(`   - Average Domain Relevance: ${summary.legacy.avg_scores.DomainRelevance}/10`);
      console.log(
        `   - Average Factuality: ${summary.legacy.avg_scores.Factuality}/10`,
      )
      // console.log(`   - Average Semantic Similarity: ${summary.legacy.avg_scores.SemanticSimilarity}/10`);
      console.log(
        `   - Average Completeness: ${summary.legacy.avg_scores.Completeness}/10`,
      )
    }

    const finalOutput = {
      results: allScoredResults,
      summary: summary,
    }

    console.log(
      `\n💾 Saving final results with summary to: ${resolvedOutputPath}`,
    )
    const finalOutputContent = JSON.stringify(finalOutput, null, 2)
    await fs.writeFile(resolvedOutputPath, finalOutputContent, "utf-8")
    console.log(`✅ Final results with summary saved successfully!`)

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
   ground truth Answer on four criteria: DomainRelevance, Factuality, 
   SemanticSimilarity, and Completeness using OSS 120B model.
   
   For each query, it calculates:
   - Individual scores (1-10) for each criterion
   - overall_score: (sum of all four criteria)/40 as percentage (0-1)
   - final_score: sum of all overall_scores from all queries

📋 Parameters:
   input_file.json   - JSON file with evaluation items (default: ${DEFAULT_INPUT_FILE})
   output_file.json  - Output file (default: ${DEFAULT_OUTPUT_FILE})

📊 Examples:
   bun run scorer.ts                                    # Use default files
   bun run scorer.ts custom_input.json                  # Custom input, default output
   bun run scorer.ts custom_input.json custom_out.json  # Custom input and output

🔧 Configuration:
   Model: ${OPENAI_MODEL}
   Endpoint: ${BASE_URL}
   Batch Size: 3 items per batch (for immediate saving)
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
