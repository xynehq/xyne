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
  "/Users/telkar.varasree/Downloads/xyne/server/old_agentic_answers.json"
const DEFAULT_OUTPUT_FILE =
  "/Users/telkar.varasree/Desktop/xyne/server/old_agentic_answers_eval.json"

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
  Non_agentic_answer?: string
  Agentic_answer: string // Optional field for agentic answers
}

// Interface for the output with scores
interface ScoredEvaluationItem extends EvaluationItem {
  score: {
    DomainRelevance: number
    Factuality: number
    SemanticSimilarity: number
    Completeness: number
    Penalty?: number
    PenaltyReason?: string
  }
  overall_score: number
}

// Helper function to calculate overall score as percentage
function calculateOverallScore(score: {
  DomainRelevance: number
  Factuality: number
  SemanticSimilarity: number
  Completeness: number
  Penalty?: number // optional field
}): number {
  const sum =
    score.DomainRelevance +
    score.Factuality +
    score.SemanticSimilarity +
    score.Completeness

  // average percentage score (0–1 range)
  let result = sum / 40

  // subtract penalty if present
  if (score.Penalty && score.Penalty !== 0) {
    result = result - Math.abs(score.Penalty) / 40
  }

  // round to 4 decimal places
  return Math.round(result * 10000) / 10000
}

// Call OSS 120B LLM with prompt for scoring
async function callLLMForScoring(
  prompt: string,
  batchNumber: number,
  batch: EvaluationItem[],
  maxRetries = 3,
): Promise<any> {
  console.log(
    `🔧 Starting LLM scoring call for batch ${batchNumber} using model: ${OPENAI_MODEL}`,
  )

  let lastError: any
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🔧 LLM scoring attempt ${attempt}/${maxRetries} for batch ${batchNumber}`,
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
        max_tokens: 8000, // Increased for larger JSON responses
        top_p: 0.8,
      }

      console.log(
        `📤 Sending scoring request to LLM for batch ${batchNumber}...`,
      )

      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const responseData = await response.json()

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

      // Try to parse JSON response
      try {
        // Clean the content of code blocks if they exist
        let cleanContent = content

        // Remove markdown code blocks
        const jsonMatch = content.match(/```json([\s\S]*?)```/)
        if (jsonMatch) {
          cleanContent = jsonMatch[1].trim()
        } else if (content.includes("```")) {
          // Remove any remaining code block markers
          cleanContent = content
            .replace(/```[a-z]*\n?/g, "")
            .replace(/```/g, "")
            .trim()
        }

        // Try to extract JSON array from the content if no code blocks
        if (!jsonMatch && !cleanContent.startsWith("[")) {
          const arrayMatch = content.match(/\[[\s\S]*\]/)
          if (arrayMatch) {
            cleanContent = arrayMatch[0]
          }
        }

        console.log(
          `🔍 Attempting to parse JSON response for batch ${batchNumber}...`,
        )
        console.log(`📋 Content preview: ${cleanContent.substring(0, 200)}...`)

        const parsedResult = JSON.parse(cleanContent)

        // Validate that it's an array
        if (!Array.isArray(parsedResult)) {
          throw new Error("Parsed result is not an array")
        }

        return parsedResult
      } catch (parseError) {
        console.error(
          `❌ JSON parse failed for batch ${batchNumber}:`,
          parseError,
        )
        console.log(`📋 Raw content sample: ${content.substring(0, 500)}...`)

        // Try to extract JSON array from the content with different patterns
        const patterns = [
          /\[[\s\S]*?\]/g, // Simple array pattern
          /```json\s*(\[[\s\S]*?\])\s*```/, // JSON in code blocks
          /(\[[\s\S]*?\])/, // Any array pattern
        ]

        for (const pattern of patterns) {
          try {
            const matches = content.match(pattern)
            if (matches) {
              console.log(`🔍 Trying pattern match for batch ${batchNumber}...`)
              const candidate = Array.isArray(matches)
                ? matches[0]
                : matches[1] || matches[0]
              const parsed = JSON.parse(candidate)
              if (Array.isArray(parsed)) {
                console.log(
                  `✅ Successfully parsed with pattern for batch ${batchNumber}`,
                )
                return parsed
              }
            }
          } catch (patternError) {
            // Continue to next pattern
            continue
          }
        }

        // If all parsing fails, return error structure for each expected item
        console.warn(
          `⚠️  Could not parse scoring response for batch ${batchNumber}, returning error structures`,
        )
        const errorResults = []
        for (let i = 0; i < batch.length; i++) {
          errorResults.push({
            ...batch[i],
            error: "Failed to parse JSON scoring response",
            raw_content_sample: content.substring(0, 300) + "...",
            batch: batchNumber,
            item_index: i,
          })
        }
        return errorResults
      }
    } catch (err: any) {
      lastError = err
      console.error(
        `❌ LLM scoring call attempt ${attempt}/${maxRetries} failed for batch ${batchNumber}:`,
        {
          error: err.message,
          model: OPENAI_MODEL,
          baseUrl: BASE_URL,
        },
      )

      // Exponential backoff with jitter
      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 1000
        const jitter = Math.random() * 500
        const delay = baseDelay + jitter
        console.log(
          `⏳ Retrying batch ${batchNumber} in ${Math.round(delay)}ms...`,
        )
        await new Promise((res) => setTimeout(res, delay))
      }
    }
  }

  throw new Error(
    `LLM scoring call failed for batch ${batchNumber} after ${maxRetries} attempts. Last error: ${lastError}`,
  )
}

// Create scoring prompt for a batch of items
function createScoringPrompt(batch: EvaluationItem[]): string {
  return `

You are an __EXPERT EVALUATION SYSTEM__ designed to score answer quality for Retrieval-Augmented Generation (RAG) systems. Your task is to evaluate answers against ground truth and provide precise, consistent numerical scores with detailed justifications.

---

## __CORE EVALUATION PRINCIPLES__

1. __Objectivity First__: Base scores on observable evidence, not assumptions
2. __Consistency__: Apply the same standards across all evaluations
3. __Granularity__: Use the full 1-10 scale; avoid clustering around middle values
4. __Evidence-Based__: Every score must be justified with specific examples
5. __Comparative Analysis__: Always compare agentic_answer against ground truth (Answer field)

---

## __SCORING CRITERIA__

Evaluate each answer pair on these four factors (scale 1-10). Each score must be an integer with clear justification.

### __1. DomainRelevance (1-10)__

__Definition:__ How well the answer addresses the specific domain/topic of the question and stays focused on the core business/technical concepts.

__Detailed Scoring Rubric:__

__Score 10 (Perfect Relevance):__

- Every sentence directly addresses the question's domain
- No tangential or off-topic content
- Focuses precisely on the core business/technical concepts asked about
- Example: Question about "NPCI API rate limiting" → Answer discusses only NPCI rate limits, TPS caps, and related technical details

__Score 7-9 (High Relevance):__

- Primarily focused on the correct domain
- Minor tangential elements that don't detract from main answer
- May include brief contextual information that's helpful but not strictly necessary
- Example: Includes brief background on why rate limiting exists before answering the specific question

__Score 4-6 (Moderate Relevance):__

- Addresses the domain but includes significant off-topic content
- May discuss related but not directly relevant concepts
- Partially answers the question but wanders into other areas
- Example: Question about specific error code → Answer discusses the error but spends equal time on unrelated system architecture

__Score 1-3 (Poor Relevance):__

- Mostly off-topic or generic information
- Fails to address the specific domain asked about
- May be technically correct but answers a different question
- Example: Question about specific JIRA ticket → Answer provides general project management advice

__Common Pitfalls to Avoid:__

- Don't penalize for providing helpful context that enhances understanding
- Don't confuse "comprehensive" with "irrelevant"
- Consider whether additional information serves the user's need

---

### __2. Factuality (1-10)__

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

### __3. SemanticSimilarity (1-10)__

__Definition:__ How closely the answer's meaning and conceptual content aligns with the ground truth, regardless of exact wording.

__Detailed Scoring Rubric:__

__Score 10 (Semantically Identical):__

- Same key concepts expressed
- Same relationships between concepts
- Same conclusions/implications
- Different words but identical meaning
- Example: "The system failed due to timeout" ≈ "Timeout caused the system failure"

__Score 7-9 (Very Similar):__

- All major concepts present
- Minor differences in emphasis or framing
- Same overall message with slight variations
- Example: Ground truth emphasizes technical cause, agentic answer emphasizes business impact, but both mention both aspects

__Score 4-6 (Partially Similar):__

- Some key concepts match
- Missing some important conceptual elements
- Different framing that changes nuance
- Example: Ground truth discusses both immediate and long-term fixes; agentic answer only discusses immediate fix

__Score 1-3 (Different Meaning):__

- Few or no matching concepts
- Fundamentally different interpretation
- Answers a different aspect of the question
- Example: Ground truth explains "why" something happened; agentic answer only describes "what" happened

__Key Evaluation Questions:__

- Would a domain expert consider these answers equivalent?
- Do they lead to the same understanding?
- Are the actionable takeaways the same?

---

### __4. Completeness (1-10)__

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

__Good Reason Examples:__

__Example 1:__ "DomainRelevance scored 9 because the answer directly addresses NPCI rate limiting with specific TPS numbers and error codes. Factuality scored 10 as all technical details match the ground truth exactly, including the 429 error code and 80 TPS limit."

__Example 2:__ "SemanticSimilarity scored 7 because while both answers discuss the OAuth failure, the agentic answer emphasizes the timeline differently. Completeness scored 6 as it omits the JIRA ticket number and the specific person who escalated the issue."

__Example 3:__ "DomainRelevance scored 5 because the answer discusses general authentication concepts when the question specifically asked about a particular incident. Factuality scored 8 with minor deviation in the reported latency (450ms vs 480ms)."

__Poor Reason Examples (Avoid These):__

❌ "The answer is good." (Too vague) ❌ "Scores are based on comparison." (Doesn't explain specific reasoning) ❌ "DomainRelevance is 7." (Just restates the score without justification)

__Reason Field Requirements:__

- Must reference specific elements from the answer
- Should mention at least 2-3 of the 4 parameters
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

javascript
MISSING TRUTH: [List specific facts from ground truth not in agentic answer]

CONTRADICTIONS: [List any direct factual conflicts]

DEVIATIONS: [List nuanced differences or approximations]

ADDITIONAL CONTEXT: [Note any extra information provided]

OVERALL ASSESSMENT: [1-sentence summary of the gap analysis]


__Complete Insights Example:__

javascript
MISSING TRUTH: The agentic answer omits the specific error code (E-408: Invalid_Risk_Payload), the affected API endpoint (NPCI/Aadhaar/v3.1/verify), and the 18.5% failure rate mentioned in ground truth.

CONTRADICTIONS: None found - all overlapping information is factually consistent.

DEVIATIONS: Ground truth specifies "users flagged as HIGH_RISK" while agentic answer uses the more general term "high-risk customer segments." The meaning is equivalent but precision differs.

ADDITIONAL CONTEXT: Agentic answer includes information about related JIRA tickets (PAY-5011, PAY-8054) and work IDs not mentioned in ground truth, providing broader project context.

OVERALL ASSESSMENT: The agentic answer captures the general issue but lacks the technical specificity (error codes, endpoints, metrics) that makes the ground truth actionable for engineers.


__When Insights Can Be Brief:__

If the agentic answer is highly accurate and complete: "No significant missing information or contradictions found. The agentic answer comprehensively covers all points from the ground truth with equivalent semantic meaning and factual accuracy."

---

## __EVALUATION WORKFLOW__

Follow this systematic process for each evaluation:

### __Step 1: Initial Reading__

- Read the Question to understand context
- Read the Ground Truth (Answer field) completely
- Read the Agentic Answer completely
- Note your initial impressions

### __Step 2: Domain Relevance Check__

- Does the agentic answer stay on topic?
- Is it addressing the specific domain asked about?
- Assign DomainRelevance score (1-10)

### __Step 3: Factuality Analysis__

- Create a list of factual claims in ground truth
- Check each claim against agentic answer
- Mark: ✓ (matches), ✗ (contradicts), ○ (not mentioned)
- Count contradictions
- Assign Factuality score (1-10)

### __Step 4: Semantic Similarity Assessment__

- Identify key concepts in ground truth
- Check if same concepts appear in agentic answer (even if worded differently)
- Assess if the overall meaning/message is equivalent
- Assign SemanticSimilarity score (1-10)

### __Step 5: Completeness Evaluation__

- List all elements/sub-questions in ground truth
- Check coverage in agentic answer
- Calculate percentage of elements addressed
- Assign Completeness score (1-10)

### __Step 6: Write Reason__

- Summarize your scoring rationale in 1-2 sentences
- Reference specific observations
- Mention at least 2-3 parameters

### __Step 7: Write Insights__

- Document missing information
- Note any contradictions
- Highlight deviations
- Mention additional context if relevant
- Provide overall assessment

### __Step 8: Quality Check__

- Verify all scores are integers 1-10
- Ensure Reason is concise and specific
- Confirm Insights provides actionable detail
- Check JSON formatting is valid

---

## __SCORING CONSISTENCY GUIDELINES__

### __Calibration Examples__

__Example 1: High-Quality Match__

__Question:__ "What was the root cause of the latency spike in PAY-7089?"

__Ground Truth:__ "The root cause was a new set of fraud rules that triggered an inefficient query plan against the read-replica of the primary PostgreSQL instance, causing CPU utilization to peak at 92%."

__Agentic Answer:__ "Investigation revealed that newly deployed fraud detection rules caused database performance issues. The inefficient query execution against the PostgreSQL read replica led to CPU usage spiking to 92%, resulting in the observed latency increase."

__Scores:__

- DomainRelevance: 10 (perfectly on-topic, discusses exact issue)
- Factuality: 10 (all facts match: fraud rules, query inefficiency, PostgreSQL replica, 92% CPU)
- SemanticSimilarity: 10 (identical meaning, just rephrased)
- Completeness: 10 (covers all elements: cause, mechanism, impact)

__Reason:__ "All parameters scored 10 because the agentic answer accurately captures every element from ground truth with perfect factual alignment and semantic equivalence, just using different phrasing."

__Insights:__ "No missing information or contradictions. The agentic answer provides the same technical details (fraud rules, PostgreSQL read-replica, 92% CPU) with equivalent meaning. The slight rewording doesn't affect accuracy or completeness."

---

__Example 2: Good but Incomplete__

__Question:__ "What were the three action items from the PAY-1423 meeting?"

__Ground Truth:__ "1) Formalize UAT and Deployment Runbook on Confluence (Owner: anand.kumar@juspay.in, due EOD). 2) Provide written confirmation of compliance impact (Owner: sonia.gupta@juspay.in, due by timestamp 1757948400000)."

__Agentic Answer:__ "The meeting resulted in two main action items: creating a UAT deployment runbook and providing compliance impact documentation. Anand Kumar was assigned to handle the runbook documentation."

__Scores:__

- DomainRelevance: 9 (directly addresses meeting action items)
- Factuality: 8 (correct items and one owner, but missing specific details)
- SemanticSimilarity: 7 (captures general meaning but less precise)
- Completeness: 6 (covers main items but omits deadlines, second owner, and specific platform)

__Reason:__ "DomainRelevance scored 9 as it directly addresses the meeting outcomes. Completeness scored 6 because while it mentions both action items, it omits critical details like specific deadlines, the second owner (Sonia Gupta), and the Confluence platform specification."

__Insights:__ "MISSING TRUTH: The agentic answer omits the specific deadline (EOD) for the first action item, the timestamp (1757948400000) for the second item, the second owner (sonia.gupta@juspay.in), and the specific platform (Confluence). DEVIATIONS: Uses general terms like 'deployment runbook' instead of the specific 'UAT and Deployment Runbook.' OVERALL: Captures the essence but lacks the precision needed for actionable follow-up."

---

__Example 3: Factual Contradiction__

__Question:__ "What JIRA ticket is tracking the OAuth token issue?"

__Ground Truth:__ "The issue is tracked in JIRA PAY-3073."

__Agentic Answer:__ "Based on the communications, this OAuth token refresh problem is being tracked in JIRA ticket PAY-8199."

__Scores:__

- DomainRelevance: 10 (directly answers the question)
- Factuality: 1 (completely wrong JIRA ticket number)
- SemanticSimilarity: 8 (understands it's about tracking, just wrong ticket)
- Completeness: 10 (provides a ticket number as requested)

__Reason:__ "Factuality scored 1 due to a critical error: the agentic answer provides the wrong JIRA ticket (PAY-8199 instead of PAY-3073), making the information unusable despite being otherwise well-structured."

__Insights:__ "CONTRADICTION: Ground truth specifies JIRA PAY-3073, but agentic answer states PAY-8199. This is a direct factual error that would misdirect anyone trying to find the relevant ticket. While the answer demonstrates understanding that the issue is tracked in JIRA, the incorrect ticket number makes it factually wrong and potentially harmful."

---

## __EDGE CASES AND SPECIAL SITUATIONS__

### __Case 1: Ground Truth is Vague__

If ground truth lacks specificity, don't penalize agentic answer for being more specific (unless it contradicts).

__Example:__

- Ground Truth: "There was a performance issue"
- Agentic Answer: "There was a p99 latency spike to 850ms"
- Scoring: High scores if the specific detail is accurate

### __Case 2: Multiple Valid Interpretations__

If the question allows multiple valid answers, score based on whether agentic answer provides A valid answer, not THE ONLY answer.

### __Case 3: Agentic Answer Says "I Don't Know"__

- DomainRelevance: Score based on whether it correctly identifies the domain
- Factuality: 10 (no false information provided)
- SemanticSimilarity: 1-3 (doesn't match ground truth meaning)
- Completeness: 1 (provides no information)

### __Case 4: Conflicting Information in Ground Truth__

If ground truth contains internal contradictions, note this in Insights and score based on which interpretation agentic answer follows.

### __Case 5: Temporal Differences__

If ground truth says "yesterday" and agentic answer provides the specific date, this is enhancement, not deviation (assuming date is correct).

---

## __CRITICAL INSTRUCTIONS__

1. __Return ONLY valid JSON__ - No markdown, no code blocks, no explanations outside the JSON
2. __Start with [ and end with ]__ - Pure JSON array format
3. __Preserve all original fields__ exactly as provided in input
4. __Add only the "score" field__ with the four numerical scores, Reason, and Insights
5. __Use integer scores only__ (1-10, no decimals)
6. __Ensure valid JSON syntax__ - No trailing commas, proper escaping
7. __Do not modify__ any existing field values from the input

---

## __OUTPUT FORMAT__

json
[
  {
    "User_data": { ... },
    "Question_weights": { ... },
    "Question": "...",
    "Answer_weights": { ... },
    "Answer": "...",
    "Confidence": ...,
    "Agentic_answer": "...",
    "score": {
      "DomainRelevance": 8,
      "Factuality": 9,
      "SemanticSimilarity": 7,
      "Completeness": 8,
      "Reason": "DomainRelevance scored 8 because the answer directly addresses the NPCI rate limiting issue with specific technical details. Completeness scored 8 as it covers the main points but omits the specific JIRA ticket number mentioned in ground truth.",
      "Insights": "MISSING TRUTH: The ground truth mentions JIRA ticket PAY-4510, which is omitted from the agentic answer. DEVIATIONS: Ground truth specifies '12,000 TPS' while agentic answer uses 'at least 12,000 TPS' - semantically equivalent. OVERALL: The agentic answer captures the core issue accurately but lacks the specific tracking reference."
    }
  }
]


---

## __FINAL QUALITY CHECKLIST__

Before submitting your evaluation, verify:

- [ ] All scores are integers between 1-10
- [ ] Reason field is 1-2 sentences and references specific observations
- [ ] Insights field provides detailed analysis with categories
- [ ] No contradictions between your scores and explanations
- [ ] JSON is valid and properly formatted
- [ ] All original fields are preserved unchanged
- [ ] You've used the full scoring range (not clustering around 5-7)

---

__BEGIN EVALUATION NOW__

Input Data: ${JSON.stringify(batch, null, 2)}
In each JSON Object : "Question" field is the question, "Answer" is the Ground Truth and "Agentic_answer" is the answer to be evaluated.

Return the scored JSON array following all guidelines above.
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

      if (result.error) {
        console.error(
          `❌ Error in batch ${batchNumber}, item ${i}:`,
          result.error,
        )
        // Create a default score for error cases
        const originalItem = batch[i] || batch[0] // Fallback to first item if index mismatch
        const defaultScore = {
          DomainRelevance: 1,
          Factuality: 1,
          SemanticSimilarity: 1,
          Completeness: 1,
        }
        validatedResults.push({
          ...originalItem,
          score: defaultScore,
          overall_score: calculateOverallScore(defaultScore),
        })
      } else if (
        result.score &&
        typeof result.score.DomainRelevance === "number" &&
        typeof result.score.Factuality === "number" &&
        typeof result.score.SemanticSimilarity === "number" &&
        typeof result.score.Completeness === "number"
      ) {
        // Add overall_score if it doesn't exist
        const scoredItem: ScoredEvaluationItem = {
          ...result,
          overall_score:
            result.overall_score || calculateOverallScore(result.score),
        }
        validatedResults.push(scoredItem)

        // Log penalty information if present
        if (result.score.Penalty && result.score.PenaltyReason) {
          console.log(
            `✅ Batch ${batchNumber}, item ${i}: Valid score received with penalty ${result.score.Penalty} (${result.score.PenaltyReason})`,
          )
        } else {
          console.log(
            `✅ Batch ${batchNumber}, item ${i}: Valid score received`,
          )
        }
      } else {
        console.warn(
          `⚠️  Batch ${batchNumber}, item ${i}: Invalid score format, using defaults`,
        )
        const originalItem = batch[i] || batch[0]
        const defaultScore = {
          DomainRelevance: 5,
          Factuality: 5,
          SemanticSimilarity: 5,
          Completeness: 5,
        }
        validatedResults.push({
          ...originalItem,
          score: defaultScore,
          overall_score: calculateOverallScore(defaultScore),
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
          DomainRelevance: 1,
          Factuality: 1,
          SemanticSimilarity: 1,
          Completeness: 1,
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

    // Process in batches of 3 for immediate saving (smaller batches for better JSON parsing)
    const batchSize = 3
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
            DomainRelevance: 1,
            Factuality: 1,
            SemanticSimilarity: 1,
            Completeness: 1,
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

    // Final save
    console.log(`💾 Saving final results to: ${resolvedOutputPath}`)
    const outputContent = JSON.stringify(allScoredResults, null, 2)
    await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
    console.log(`✅ Final results saved successfully!`)

    // Print summary statistics
    console.log(`\n📈 SCORING SUMMARY:`)
    console.log(`📊 Total items processed: ${allScoredResults.length}`)

    // Calculate average scores and overall average
    const avgScores = {
      DomainRelevance: 0,
      Factuality: 0,
      SemanticSimilarity: 0,
      Completeness: 0,
    }

    let validScoreCount = 0
    let totalOverallScore = 0
    let penaltyStats = {
      totalPenalties: 0,
      totalPenaltyAmount: 0,
      penaltyReasons: {} as Record<string, number>,
    }

    for (const item of allScoredResults) {
      if (item.score) {
        avgScores.DomainRelevance += item.score.DomainRelevance
        avgScores.Factuality += item.score.Factuality
        avgScores.SemanticSimilarity += item.score.SemanticSimilarity
        avgScores.Completeness += item.score.Completeness
        totalOverallScore += item.overall_score
        validScoreCount++

        // Track penalty statistics
        if (item.score.Penalty && item.score.Penalty !== 0) {
          penaltyStats.totalPenalties++
          penaltyStats.totalPenaltyAmount += Math.abs(item.score.Penalty)

          if (item.score.PenaltyReason) {
            const reason = item.score.PenaltyReason
            penaltyStats.penaltyReasons[reason] =
              (penaltyStats.penaltyReasons[reason] || 0) + 1
          }
        }
      }
    }

    if (validScoreCount > 0) {
      avgScores.DomainRelevance =
        Math.round((avgScores.DomainRelevance / validScoreCount) * 100) / 100
      avgScores.Factuality =
        Math.round((avgScores.Factuality / validScoreCount) * 100) / 100
      avgScores.SemanticSimilarity =
        Math.round((avgScores.SemanticSimilarity / validScoreCount) * 100) / 100
      avgScores.Completeness =
        Math.round((avgScores.Completeness / validScoreCount) * 100) / 100

      // Calculate average overall score and final score (sum of all overall scores)
      const averageScore =
        Math.round((totalOverallScore / validScoreCount) * 10000) / 10000
      const finalScore = Math.round(totalOverallScore * 10000) / 10000

      console.log(`📊 Average Scores:`)
      console.log(`   🎯 Domain Relevance: ${avgScores.DomainRelevance}/10`)
      console.log(`   ✅ Factuality: ${avgScores.Factuality}/10`)
      console.log(
        `   🔗 Semantic Similarity: ${avgScores.SemanticSimilarity}/10`,
      )
      console.log(`   📋 Completeness: ${avgScores.Completeness}/10`)
      console.log(`   🏆 Average Overall Score: ${averageScore} (percentage)`)
      console.log(
        `   🎯 Final Score (Sum of all overall scores): ${finalScore}`,
      )

      // Display penalty statistics
      if (penaltyStats.totalPenalties > 0) {
        console.log(`\n⚠️  PENALTY STATISTICS:`)
        console.log(
          `   📊 Total items with penalties: ${penaltyStats.totalPenalties}/${validScoreCount} (${Math.round((penaltyStats.totalPenalties / validScoreCount) * 100)}%)`,
        )
        console.log(
          `   📉 Total penalty amount: ${penaltyStats.totalPenaltyAmount}`,
        )
        console.log(
          `   📊 Average penalty per penalized item: ${Math.round((penaltyStats.totalPenaltyAmount / penaltyStats.totalPenalties) * 100) / 100}`,
        )
        console.log(`   📋 Penalty reasons breakdown:`)
        for (const [reason, count] of Object.entries(
          penaltyStats.penaltyReasons,
        )) {
          console.log(`      • ${reason}: ${count} items`)
        }
      } else {
        console.log(`\n✅ No penalties applied to any items`)
      }

      // Add average_score and final_score to the final output
      const finalOutput = {
        results: allScoredResults,
        summary: {
          total_items: allScoredResults.length,
          average_scores: avgScores,
          average_score: averageScore,
          final_score: finalScore,
        },
      }

      // Save final results with summary
      console.log(
        `💾 Saving final results with summary to: ${resolvedOutputPath}`,
      )
      const outputContent = JSON.stringify(finalOutput, null, 2)
      await fs.writeFile(resolvedOutputPath, outputContent, "utf-8")
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
