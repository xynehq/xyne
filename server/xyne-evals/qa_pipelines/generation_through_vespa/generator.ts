import { VertexAI } from "@google-cloud/vertexai"
import { evaluator } from "./evaluator.ts"
import type { QAItem } from "./types.ts"
import { DataStore } from "./dataStore"
import * as dotenv from "dotenv"
import * as fs from "fs/promises"
import * as path from "path"

// Load environment variables
dotenv.config({ path: "../../server/.env" })

// Configuration from environment variables
const VertexProjectId = process.env.VERTEX_PROJECT_ID || "dev-ai-gamma"
const VertexRegion = process.env.VERTEX_REGION || "us-east5"
const VertexAIModel = "gemini-2.5-pro"

// Use the model from environment, fallback to a working model
const defaultFastModel = VertexAIModel
const defaultBestModel = VertexAIModel

// Simple logger replacement
const Logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
}

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
        return JSON.parse(content)
      } catch (e) {
        console.log(
          "📝 Direct JSON parse failed, trying to extract JSON from response...",
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
            Answer: content.substring(0, 500) + "...",
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
        const baseDelay = Math.pow(2, attempt) * 1000
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

// Main generator function adapted for vespa results
export async function generator(
  vespaResults: any[],
  numQuestions: number,
  groupIdentifier?: string,
) {
  console.log(
    `🤖 Starting generator for ${vespaResults.length} vespa search results`,
  )

  try {
    // Convert vespa results to documents format
    const documents = vespaResults.map((result) => {
      // Handle both vespa search results and direct document references
      if (result.fields) {
        return result // Already in the right format
      } else {
        // This is a vespa search result, extract the fields
        return {
          fields: {
            docId: result.fields?.docId || result.id || `unknown_${Date.now()}`,
            type: result.fields?.type || "unknown",
            chunks: result.fields?.chunks || [],
            text: result.fields?.text || "",
            description: result.fields?.description || "",
            title: result.fields?.title || "",
            url: result.fields?.url || "",
            timestamp: result.fields?.timestamp || Date.now(),
          },
        }
      }
    })

    console.log(
      `📄 Converted ${documents.length} vespa results to document format`,
    )

    if (documents.length === 0) {
      console.warn("⚠️  No documents provided for generation, skipping")
      return []
    }

    // Build the generation prompt with vespa search results
    const generation_prompt = `
## **SYSTEM ROLE & OBJECTIVE**

You are an **EXPERT EVALUATION SYSTEM** designed to generate **EXACTLY ${numQuestions} high-quality question-answer pairs** to assess document-grounded answers for Retrieval-Augmented Generation (RAG) pipelines.

## **PRIMARY MISSION:**

Generate diverse, auditable Q/A pairs that **STRESS-TEST** factual grounding, synthesis, breadth, and clarity across documents retrieved for a RAG based system.

---

## **INPUT CONTEXT**

- **SOURCE:** ${JSON.stringify(documents)} - Documents retrieved from vespa search
- **STRUCTURE:** Each document represents search results with:
    - **Identifiable metadata**
    - **Document types:** file | email | slack | event
    - **Content fields:** chunks, text, description based on type

## **CONFIGURATION PARAMETERS:**

- target_questions=${numQuestions}

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
- **Examples:** "What is the deadline mentioned in the document?" / "Who sent the email on March 15th?"

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
    - "What files were mentioned in the search results?"
    - "Who attended the meeting mentioned in the documents?"
    - "What's the due date mentioned in the content?"

## **MEDIUM COMPLEXITY**
- **Definition:** Multi-layered questions requiring decision-making about data selection, scope, and focus
- **Examples:**
    - "What are the main topics across all retrieved documents?"
    - "Which documents contain information about project status?"
    - "How do the different documents relate to each other?"

## **HIGH COMPLEXITY**
- **Definition:** Multi-layered, potentially interdependent questions requiring advanced inference
- **Examples:**
    - "Based on the retrieved documents, what are the underlying patterns or themes?"
    - "How do the different pieces of information connect to form a complete picture?"
    - "What insights can be drawn from analyzing all the retrieved content together?"

## **C. REALNESS CATEGORIES**

## **STATUS**
- **Definition:** Questions about project status, updates, progress tracking
- **Examples:**
    - "What's the current status mentioned in the documents?"
    - "Are there any progress updates in the retrieved content?"
    - "Which deliverables are mentioned as complete or pending?"

## **FACT**
- **Definition:** Factual queries requiring search, retrieval, and fact verification
- **Examples:**
    - "Who are the people mentioned in the documents?"
    - "What dates and times are referenced in the content?"
    - "Which specific tools, technologies, or processes are discussed?"

## **INFER**
- **Definition:** Conceptual questions requiring analysis, pattern recognition, and inference
- **Examples:**
    - "What are the recurring themes across the documents?"
    - "How might the information in these documents impact decision-making?"
    - "What conclusions can be drawn from the collective content?"

---

## **GENERATION PROCESS**

## **STEP 1: DATA ANALYSIS**
1. **PARSE** the provided input context thoroughly
2. **IDENTIFY** available document types and content
3. **EXTRACT** key metadata: timestamps, users, topics, priorities
4. **MAP** relationships and connections between documents
5. **ASSIGN** a value for "Coverage_preference" from ['low', 'medium', 'high'] based on the size of the context provided. 0 - 15 documetnts = low, 15 - 30 = medium, 31+ = high

## **STEP 2: USER SELECTION**
- **CHOOSE** a realistic user based on the document content
- **ASSIGN** UserID (email format) and User_name
- **ENSURE** the selected user has logical access to the queried information

## **STEP 3: QUESTION GENERATION**
- **GENERATE** questions that strictly adhere to the provided attribute values
- **GROUND** all questions in available document context from vespa results
- **AVOID** external facts, interpretations, or unit conversions
- **VARY** question types across the ${numQuestions} pairs
- **ENSURE** all questions can be answered with the provided documents only

## **STEP 4: QUESTION ANALYSIS**

Analyze each generated question to determine:

## **REASONING TYPES:**
- **FACT-BASED:** Direct information retrieval from documents
- **INFERENTIAL:** Requires analysis, synthesis, or pattern recognition

## **QUESTION_FORMAT TYPES:**
- **DEFINITIVE:** Seeks specific, single answers
- **LISTING:** Requests multiple items or enumerated responses
- **STATUS:** Inquires about current state or progress

## **STEP 5: ANSWER GENERATION**
- **BASE** answers strictly on the provided content as context
- **PROVIDE** comprehensive responses that address the question fully
- **MAINTAIN** factual accuracy without speculation
- **GENERATE** complete answers that fully address each question

---

## **CRITICAL GUIDELINES**

## **MANDATORY REQUIREMENTS:**
- **STRICTLY GROUND** all content in provided vespa search results
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
    "Answer": "Comprehensive answer grounded in vespa search results"
  }
]

---

## **EXECUTION COMMAND**

**BEGIN GENERATION NOW** using the provided vespa search results. Generate **EXACTLY ${numQuestions} high-quality Q&A pairs** following the complete process outlined above. Return ONLY the JSON array, no additional text.

Start the result with "[" and end with "]". No markdown formatting or additional commentary.`

    console.log(
      "🚀 Calling Vertex AI to generate questions from vespa results...",
    )
    // Call LLM once for all questions
    const groupId = groupIdentifier || `vespa_${Date.now()}`
    const llm_result = await call_llm(generation_prompt, groupId)
    console.log(`✅ LLM generation completed successfully`)

    // Create a Set of document IDs for citations
    const docIds = new Set(
      documents.map((doc) => doc.fields.docId).filter(Boolean),
    )
    const citationArray = Array.from(docIds)

    // Add Citations field to each QA item
    console.log("📝 Adding citations to each QA pair...")
    const enhancedResults = llm_result.map((qaItem: any) => ({
      ...qaItem,
      Citations: citationArray,
    }))

    console.log(
      `✅ Added citations array with ${citationArray.length} document IDs to ${enhancedResults.length} QA pairs`,
    )

    // Pass enhanced results to evaluator
    console.log("📊 Passing enhanced results to evaluator...")
    await evaluator(enhancedResults, docIds)
    console.log(`🎯 Generator completed successfully for vespa results`)

    return enhancedResults
  } catch (err) {
    console.error(`❌ Error in generator for vespa results:`, err)
    throw err
  }
}
