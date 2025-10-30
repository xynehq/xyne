import { VertexAI } from "@google-cloud/vertexai"
import { evaluator } from "./evaluator"
import type { QAItem } from "./types"
import { DataStore, GroupMetadata } from "./dataStore"
import * as dotenv from "dotenv"
import * as fs from "fs/promises"
import * as path from "path"

// Load environment variables
dotenv.config({ path: "../../server/.env" })

// Configuration from environment variables (matching eval.ts approach)
const VertexProjectId = process.env.VERTEX_PROJECT_ID || "dev-ai-gamma"
const VertexRegion = process.env.VERTEX_REGION || "us-east5"
const VertexAIModel = process.env.VERTEX_AI_MODEL || "gemini-2.5-pro"

// Use the model from environment, fallback to a working model
const defaultFastModel = VertexAIModel
const defaultBestModel = VertexAIModel

// Simple logger replacement
const Logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
}

const myEmail = "oindrila@rbi.in"
const workspaceId = "rddl9wm8ds0p09uhddoo61pl"
const agentId = "i5bauhvg5p5e136fwkanq870"

// Call Vertex AI LLM with prompt, with retries and robust output parsing
async function call_llm(
  prompt: string,
  groupId?: string,
  maxRetries = 3,
): Promise<any> {
  const project = VertexProjectId
  const location = VertexRegion
  const model = defaultFastModel

  if (!project) throw new Error("VERTEX_PROJECT_ID env var not set")

  let lastError: any
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🔧 LLM call attempt ${attempt}/${maxRetries} using model: ${model}`,
      )

      const vertexAI = new VertexAI({
        project: project,
        location: location,
      })

      const generativeModel = vertexAI.getGenerativeModel({
        model: model,
        generationConfig: {
          maxOutputTokens: 8000,
          temperature: 0.7,
          topP: 0.8,
          topK: 40,
        },
      })
      //get user name correctly, my name??
      const contents = [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ]

      const response = await generativeModel.generateContent({ contents })

      // Wait a bit to ensure the response is fully received
      await new Promise((resolve) => setTimeout(resolve, 3000))

      let content = ""
      const candidate = response.response.candidates?.[0]

      if (!candidate) {
        throw new Error("No response received from Vertex AI model")
      }

      // More robust content extraction
      if (candidate.content?.parts) {
        // Concatenate all text parts to ensure we get the complete response
        const textParts = candidate.content.parts
          .filter((part) => part.text)
          .map((part) => part.text)

        if (textParts.length > 0) {
          content = textParts.join("").trim()
        }
      }

      if (!content) {
        throw new Error("No valid LLM output received")
      }

      // Additional check for incomplete JSON responses
      if (
        content.includes("```json") &&
        !content.includes("```", content.indexOf("```json") + 7)
      ) {
        console.warn(
          "⚠️  Detected potentially incomplete JSON response, waiting for completion...",
        )
        await new Promise((resolve) => setTimeout(resolve, 2000))

        // Try to get the response again
        const retryResponse = await generativeModel.generateContent({
          contents,
        })
        const retryCandidate = retryResponse.response.candidates?.[0]

        if (retryCandidate?.content?.parts) {
          const retryTextParts = retryCandidate.content.parts
            .filter((part) => part.text)
            .map((part) => part.text)

          if (retryTextParts.length > 0) {
            const retryContent = retryTextParts.join("").trim()
            if (retryContent.length > content.length) {
              content = retryContent
              console.log("✅ Retrieved more complete response on retry")
            }
          }
        }
      }

      console.log(`✅ LLM call successful, content length: ${content.length}`)
      // console.log(`this is the content : ${content}`);

      //clean the content of the code blocks if it exists for ex : "''' json" in the beginning and "'''" in the end....

      // Save LLM output to llm_outputs folder if groupId is provided
      if (groupId) {
        try {
          const outputDir = path.join(
            path.dirname(path.dirname(__filename)),
            "llm_outputs",
          )
          await fs.mkdir(outputDir, { recursive: true })
          const outputFile = path.join(outputDir, `${groupId}.txt`)
          await fs.writeFile(outputFile, content, "utf-8")
          console.log(`💾 LLM output saved to: ${outputFile}`)
        } catch (saveError) {
          console.warn(
            `⚠️  Failed to save LLM output for group ${groupId}:`,
            saveError,
          )
        }
      }

      // Try direct JSON parse
      try {
        return JSON.parse(content) //THIS LINE IS THE ISSUE, PARSING IS NOT HAPPENING... WHY??????????????
      } catch (e) {
        console.log(
          "📝 Direct JSON parse failed, trying to extract JSON from response..., by taking out the code block",
        )

        // Try to extract JSON from markdown code block
        const match = content.match(/```json([\s\S]*?)```/)
        if (match) {
          try {
            return JSON.parse(match[1].trim())
          } catch {}
        }

        // Try to extract any JSON substring
        const jsonMatch = content.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0])
          } catch {}
        }

        // If all parsing fails, return the raw content wrapped in an array
        console.warn("⚠️  Could not parse as JSON, returning raw content")
        return [
          {
            error: "Failed to parse JSON",
            raw_content: content,
            User_data: {
              UserID: "unknown@example.com",
              User_name: "Unknown User",
            },
            Question_weights: {
              Coverage_preference: "medium",
              Vagueness: 0.5,
              Question_Complexity: "medium",
              Realness: 0.5,
              Reasoning: "fact-based",
              Question_format: "definitive",
            },
            Question: "Generated content could not be parsed as structured Q&A",
            Answer_weights: {
              Factuality: 0.5,
              Completeness: 0.5,
              Domain_relevance: 0.5,
            },
            Answer: content.substring(0, 500) + "...",
            Confidence: 0.3,
          },
        ]
      }
    } catch (err: any) {
      lastError = err
      console.error(`❌ LLM call attempt ${attempt}/${maxRetries} failed:`, {
        error: err.message,
        model: model,
        location: location,
        project: project,
      })

      // Exponential backoff with jitter
      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 1000 // Increased base delay
        const jitter = Math.random() * 500
        const delay = baseDelay + jitter
        console.log(`⏳ Retrying in ${Math.round(delay)}ms...`)
        await new Promise((res) => setTimeout(res, delay))
      }
    }
  }

  // Enhanced error message with troubleshooting info
  let errorMsg = `LLM call failed after ${maxRetries} attempts. Last error: ${lastError}`
  if (lastError?.message?.includes("timeout")) {
    errorMsg +=
      "\n💡 This appears to be a timeout error. Consider reducing document size."
  } else if (
    lastError?.message?.includes("401") ||
    lastError?.message?.includes("unauthorized")
  ) {
    errorMsg +=
      "\n💡 Authentication failed. Check VERTEX_PROJECT_ID and Google Cloud credentials."
  } else if (
    lastError?.message?.includes("404") ||
    lastError?.message?.includes("not found")
  ) {
    errorMsg +=
      "\n💡 Model not found. Verify VERTEX_AI_MODEL and VERTEX_REGION are correct."
  } else if (
    lastError?.message?.includes("400") ||
    lastError?.message?.includes("bad request")
  ) {
    errorMsg +=
      "\n💡 Bad request. Check if prompt is too large or contains invalid characters."
  }

  throw new Error(errorMsg)
}

// Main generator function (memory-optimized)
export async function generator(
  group: GroupMetadata,
  numQuestions: number,
  groupNumber?: number,
) {
  console.log(
    `🤖 Starting generator for group with ${group.docIds.size} documents`,
  )
  console.log(
    `📋 Group details: root=${group.rootId}, coverage=${group.actual_coverage_preference}`,
  )

  try {
    // Lazy load documents from DataStore
    const dataStore = DataStore.getInstance()
    if (!dataStore.isDataLoaded()) {
      throw new Error(
        "DataStore is not loaded. Ensure selector has been called first.",
      )
    }

    console.log("🔄 Lazily fetching documents for this group...")
    const groupDocuments = dataStore.getDocuments(group.docIds)
    console.log(
      `📄 Retrieved ${groupDocuments.length} documents for processing`,
    )

    if (groupDocuments.length === 0) {
      console.warn("⚠️  No documents found for this group, skipping generation")
      return []
    }

    // Build the generation prompt with fetched data
    const generation_prompt = `
        ## **SYSTEM ROLE & OBJECTIVE**

You are an **EXPERT EVALUATION SYSTEM** designed to generate **EXACTLY ${numQuestions} high-quality question-answer pairs** to assess document-grounded answers for Retrieval-Augmented Generation (RAG) pipelines using heterogeneous JSON message datasets.

## **PRIMARY MISSION:**

Generate diverse, auditable Q/A pairs that **STRESS-TEST** factual grounding, synthesis, breadth, and clarity across four modalities: **files, emails, Slack messages, and calendar events**.

---

## **INPUT CONTEXT**

## **DOCUMENT_CONTEXT:**

- **SOURCE:** ${JSON.stringify(groupDocuments)} - A bounded set of JSON records
- **STRUCTURE:** Each record represents one message-like artifact with:
    - **Identifiable metadata**
    - **One of four modalities: [to be found in fields.type in each json object] ** file | email | slack | event
    - **Body location:** to be found in fields.chunks for file, email, fields.text for slack, fields.description for event
## **CONFIGURATION PARAMETERS:**

- coverage_preference=${group.actual_coverage_preference}

---

## **RANDOM ATTRIBUTE SELECTION INSTRUCTION**

For each question you generate, **randomly select** the following attributes independently:
- **Vagueness**: a float between 0.0 and 1.0 (step 0.1)
- **Question_Complexity**: one of 'low', 'medium', 'high'
- **Realness**: one of 'status', 'fact', 'infer', 'list'

Use these randomly selected values for each Q&A pair and include them in the output as specified.

---

## **CORE ATTRIBUTES DEFINITIONS**

## **A. VAGUENESS SCALE (0.0 - 1.0)**

**0.0 - 0.2: LITERAL** - No ambiguity, direct questions

- **Examples:** "What is the deadline for Project Alpha?" / "Who sent the email on March 15th?"

**0.2 - 0.4: SEMI-LITERAL** - Concept is specific, question formation may be indirect

- **Examples:** "When do we need to wrap up the quarterly review?" / "Which team member was responsible for the backend updates?"

**0.4 - 0.6: MODERATE INFERENCE** - Some inference required for concept specificity

- **Examples:** "How are we progressing on the main deliverables?" / "What's the status of our client commitments?"

**0.6 - 0.8: HIGH INFERENCE** - Vague concept, requires essence linking between words

- **Examples:** "Are we on track with our strategic initiatives?" / "How is the team feeling about the upcoming changes?"

**0.8 - 1.0: AMBIGUOUS** - Requires meaning extraction and deep inference

- **Examples:** "What should we be focusing on?" / "How are things looking overall?"

## **B. QUESTION_COMPLEXITY LEVELS**

## **LOW COMPLEXITY**

- **Definition:** Single-layered questions requiring only data retrieval and presentation
- **Examples:**
    - "What files were shared in the #marketing channel?"
    - "Who attended the Monday standup meeting?"
    - "What's the due date for the expense report?"

## **MEDIUM COMPLEXITY**

- **Definition:** Multi-layered questions requiring decision-making about data selection, scope, and focus
- **Examples:**
    - "What are the main blockers across all active projects this month?"
    - "Which team members have been most active in cross-functional collaboration?"
    - "How has project priority shifted based on recent executive communications?"

## **HIGH COMPLEXITY**

- **Definition:** Multi-layered, potentially interdependent questions from non-unified data concepts requiring advanced inference
- **Examples:**
    - "Based on meeting notes, email threads, and project updates, what are the underlying risks to our Q4 timeline?"
    - "How do individual team member workloads correlate with project delivery success rates?"
    - "What patterns emerge when analyzing communication frequency versus project milestone completion?"

## **C. REALNESS CATEGORIES (0.0 - 1.0)**

## **STATUS (0.0 - 0.3)**

- **Definition:** Questions about project status, updates, progress tracking
- **Examples:**
    - "What's the current status of the API integration?"
    - "Are we meeting our sprint commitments?"
    - "Which deliverables are behind schedule?"

## **FACT (0.3 - 0.7)**

- **Definition:** Factual queries requiring search, retrieval, and fact verification
- **Examples:**
    - "Who approved the budget increase for the mobile app project?"
    - "What was decided in the architectural review meeting?"
    - "Which vendors were shortlisted for the security audit?"

## **INFER (0.7 - 1.0)**

- **Definition:** Conceptual questions requiring analysis, pattern recognition, and inference
- **Examples:**
    - "What are the recurring themes in customer feedback?"
    - "How might the recent organizational changes impact our delivery timeline?"
    - "What skills gaps are emerging based on project assignments?"

---

## **GENERATION PROCESS**

## **STEP 1: DATA ANALYSIS**

1. **PARSE** the provided ${JSON.stringify(groupDocuments)} JSON records
2. **IDENTIFY** available modalities (file, email, slack, event)
3. **EXTRACT** key metadata: timestamps, users, topics, priorities
4. **MAP** user relationships and communication patterns

## **STEP 2: USER SELECTION**

- **CHOOSE** a realistic user from the dataset
- **ASSIGN** UserID (email format) and User_name
- **ENSURE** the selected user has logical access to the information being queried

## **STEP 3: QUESTION GENERATION**

- **GENERATE** questions that strictly adhere to the provided attribute values
- **GROUND** all questions in available document context
- **AVOID** external facts, interpretations, or unit conversions
- **VARY** question types across the ${numQuestions} pairs
- **MAKE** only questions that can be answered with the provided documents only. Recheck questions to ensure answerability.

## **STEP 4: QUESTION ANALYSIS**

Analyze each generated question to determine:

## **REASONING TYPES:**

- **FACT-BASED:** Direct information retrieval from documents
    - *Example:* "What time is the all-hands meeting scheduled?"
- **INFERENTIAL:** Requires analysis, synthesis, or pattern recognition
    - *Example:* "Based on recent discussions, what are the team's main concerns?"

## **QUESTION_FORMAT TYPES:**

- **DEFINITIVE:** Seeks specific, single answers
    - *Example:* "Who is the project manager for the website redesign?"
- **LISTING:** Requests multiple items or enumerated responses
    - *Example:* "What are all the action items from this week's retrospective?"
- **STATUS:** Inquires about current state or progress
    - *Example:* "How is the database migration progressing?"

## **STEP 5: ANSWER GENERATION**

- **BASE** answers strictly on document context
- **PROVIDE** comprehensive responses that address the question fully
- **MAINTAIN** factual accuracy without speculation
- **GENERATE** complete answer the question asked, do not leave any part unanswered

## **STEP 6: WEIGHT CALCULATION**

Calculate Answer_weights based on these strict rules:

## **FACTUALITY (0.0 - 1.0):**

- **1.0:** Answer is 100% verifiable from source documents
- **0.7-0.9:** Mostly factual with minor inferences clearly marked
- **0.4-0.6:** Mix of facts and necessary interpretations
- **0.0-0.3:** Heavy speculation or ungrounded claims

## **COMPLETENESS (0.0 - 1.0):**

- **1.0:** Question fully answered with all relevant information
- **0.7-0.9:** Most aspects covered, minor gaps are present
- **0.4-0.6:** Partial answer, missing some important elements
- **0.0-0.3:** Incomplete or superficial response

## **DOMAIN_RELEVANCE (0.0 - 1.0):**

- **1.0:** Highly relevant to business/organizational context
- **0.7-0.9:** Relevant with clear business connection
- **0.4-0.6:** Moderately relevant, some business value
- **0.0-0.3:** Low relevance or unclear business value

## **STEP 7: CONFIDENCE SCORING**

- **CONFIDENCE (0.0 - 1.0):** Overall assessment of Q&A pair quality
- **Consider:** Question clarity, answer accuracy, grounding strength, practical utility
- **Check:** All parts of the questions are answered fully and for each part of the question, check confidence of answer accordingly and give strict confidence score with no bias.

---

## **CRITICAL GUIDELINES**

## **MANDATORY REQUIREMENTS:**

- **STRICTLY GROUND** all content in provided document context
- **MAINTAIN** chronological accuracy from source timestamps
- **PRESERVE** original terminology and naming conventions
- **ENSURE** user selections are logical and realistic
- **GENERATE** exactly ${numQuestions} distinct Q&A pairs
- **VALIDATE** all numerical values and dates against source data

## **STRICT PROHIBITIONS:**

- **NEVER** introduce external knowledge not present in documents
- **NEVER** perform unit conversions unless explicitly shown in source
- **NEVER** make assumptions about information not in the dataset
- **NEVER** create duplicate or near-duplicate questions
- **NEVER** assign questions to users without logical access rights

---

## **REQUIRED OUTPUT STRUCTURE**

Return a JSON array with exactly ${numQuestions} objects like below:
[
  {
    "User_data": {
      "UserID": "email@company.com",
      "User_name": "Full Name"
    },
    "Question_weights": {
      "Coverage_preference": "low | medium | high",
      "Vagueness": 0.0,
      "Question_Complexity": "low | medium | high", 
      "Realness": 0.0,
      "Reasoning": "fact-based | inferential",
      "Question_format": "definitive | listing | status"
    },
    "Question": "Generated question text",
    "Answer_weights": {
      "Factuality": 0.0,
      "Completeness": 0.0,
      "Domain_relevance": 0.0
    },
    "Answer": "Comprehensive answer grounded in document context",
    "Confidence": 0.0
  }
]
  // ... repeat for exactly ${numQuestions} total pairs


---

## **VALIDATION CHECKLIST**

Before finalizing each Q&A pair, verify:

- **GROUNDING:** Every factual claim traceable to source documents
- **USER LOGIC:** Selected user has reasonable access to queried information
- **ATTRIBUTE ALIGNMENT:** All weights accurately reflect the generated content
- **COMPLETENESS:** Answer fully addresses the question asked
- **DIVERSITY:** Questions span different modalities and complexity levels
- **REALISM:** Questions reflect genuine workplace information needs
- **JSON VALIDITY:** Output structure matches required format exactly

---

## **EXECUTION COMMAND**

**BEGIN GENERATION NOW** using the provided data and specified parameters. Generate **EXACTLY ${numQuestions} high-quality Q&A pairs** following the complete process outlined above. Return ONLY the JSON array, no additional text.
no additional commentary, nothing else. just array of json objects, dont even give "''' json" in the start start the result with "[" and followed by json objects in {}, {}, {} format and end with "]"`

    console.log("🚀 Calling Vertex AI to generate questions...")
    // Call LLM once for all questions
    const groupId = groupNumber ? `group_${groupNumber}` : group.rootId
    const llm_result = await call_llm(generation_prompt, groupId)
    console.log(`✅ LLM generation completed successfully`)

    // Pass to evaluator
    console.log("📊 Passing results to evaluator...")
    await evaluator(llm_result, group.docIds)
    console.log(`🎯 Generator completed successfully for group ${group.rootId}`)

    return llm_result
  } catch (err) {
    console.error(`❌ Error in generator for group ${group.rootId}:`, err)
    throw err
  }
}

//notes : check the filtered data once...
