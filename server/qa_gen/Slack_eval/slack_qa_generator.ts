import { VertexAI } from "@google-cloud/vertexai"
import * as dotenv from "dotenv"
import * as fs from "fs/promises"
import * as path from "path"

// Load environment variables
dotenv.config({ path: "../../.env" })

// Configuration
const VertexProjectId = process.env.VERTEX_PROJECT_ID || "dev-ai-gamma"
const VertexRegion = process.env.VERTEX_REGION || "us-east5"
// const VertexAIModel = process.env.VERTEX_AI_MODEL || 'claude-3-5-sonnet-v2@20241022';
const VertexAIModel = "gemini-2.5-pro"

const MESSAGES_FILE = "slack_messages.json"
const OUTPUT_FILE = "slack_qa_output.json"

// ========== GENERATION CONFIGURATION ==========
// Control how many Q&A pairs to generate for each type

const GENERATION_CONFIG = {
  type1_2: {
    enabled: true,
    count: 100, // Number of threads to process for Type 1 & 2 questions
  },
  type3: {
    enabled: true,
    numGroups: 100, // Number of Type 3 Q&A pairs to generate
    threadsPerGroup: 3, // Number of threads to bundle per group (2-5 recommended)
  },
}

// ==============================================

interface Message {
  text?: string
  name?: string
  username?: string
  userId?: string
  createdAt?: number
  mentions?: string[]
  [key: string]: any
}

interface Thread {
  threadId: string
  messageCount: number
  messages: Message[]
}

interface SlackMessagesData {
  channelId: string
  extractedAt: string
  threads: Thread[]
}

interface QAOutput {
  question_type: 1 | 2 | 3
  vagueness: number
  question: string
  answer: string
  thread_ids?: string[]
  source_thread_id?: string
}

// Call Vertex AI LLM
async function callLLM(prompt: string, maxRetries = 3): Promise<string> {
  const project = VertexProjectId
  const location = VertexRegion
  const model = VertexAIModel

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

      await new Promise((resolve) => setTimeout(resolve, 2000))

      let content = ""
      const candidate = response.response.candidates?.[0]

      if (!candidate) {
        throw new Error("No response received from Vertex AI model")
      }

      if (candidate.content?.parts) {
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

      console.log(`✅ LLM call successful, content length: ${content.length}`)
      return content
    } catch (err: any) {
      lastError = err
      console.error(
        `❌ LLM call attempt ${attempt}/${maxRetries} failed:`,
        err.message,
      )

      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 1000
        const jitter = Math.random() * 500
        const delay = baseDelay + jitter
        console.log(`⏳ Retrying in ${Math.round(delay)}ms...`)
        await new Promise((res) => setTimeout(res, delay))
      }
    }
  }

  throw new Error(
    `LLM call failed after ${maxRetries} attempts. Last error: ${lastError}`,
  )
}

// Remove user mentions from text
function removeMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim()
}

// Generate Type 1 & 2 Q&A from a single thread
async function generateType1And2QA(thread: Thread): Promise<QAOutput[]> {
  if (thread.messages.length < 3) {
    return [] // Need at least 3 messages for a potential Type 2 question
  }

  const threadContext = thread.messages
    .map((m) => `${m.name || m.username}: ${m.text}`)
    .join("\n")

  const prompt = `You are an **EXPERT TEST DATA GENERATOR** for a Retrieval-Augmented Generation (RAG) system.
Your task is to create two high-quality, realistic question-answer pairs from a single Slack conversation.

**CONTEXT:**
You are given a full Slack thread. An employee will ask questions to an internal company chatbot, and the chatbot must use this thread as its knowledge base to provide answers.

**SOURCE THREAD:**
${threadContext}

**YOUR TASK:**
1.  **Generate a "Type 1" Question-Answer Pair:**
    *   **Question:** Rephrase the **first message** of the thread into a clear, natural, standalone question an employee would ask.
    *   **Answer:** Synthesize a comprehensive answer from the **replies** in the thread. The answer must be based **ONLY** on the information in the replies.
2.  **Generate a "Type 2" Question-Answer Pair:**
    *   **Question:** Find a "hidden" question within the **replies**. This should be a question about a key detail or sub-topic that is **DIFFERENT** from the first message.
    *   **Answer:** Provide a concise, factual answer to your "hidden" question based **ONLY** on the information in the thread.
3.  **General Rules:**
    *   All questions should be realistic and phrased as if an employee is asking a chatbot.
    *   All answers must be factual and strictly derived from the provided thread context. Do not hallucinate.
    *   For each pair, assign a "vagueness" score from 0.0 (very specific) to 1.0 (very vague).
4.  **Format as JSON:** Return **ONLY** a single JSON object with the following structure. If you cannot generate one of the types, set its value to null.

{
  "type1": {
    "question": "Your clear, reformulated question from the first message.",
    "answer": "Your concise, factual answer based on the replies.",
    "vagueness": 0.1
  },
  "type2": {
    "question": "Your insightful, 'hidden' question from the replies.",
    "answer": "Your factual answer to the hidden question.",
    "vagueness": 0.3
  }
}`

  try {
    const response = await callLLM(prompt)

    let jsonStr = response.trim()
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      jsonStr = jsonMatch[0]
    }

    const parsed = JSON.parse(jsonStr)
    const results: QAOutput[] = []

    if (parsed.type1) {
      results.push({
        question_type: 1,
        vagueness: parsed.type1.vagueness || 0.5,
        question: parsed.type1.question,
        answer: parsed.type1.answer,
        source_thread_id: thread.threadId,
      })
    }

    if (parsed.type2) {
      results.push({
        question_type: 2,
        vagueness: parsed.type2.vagueness || 0.5,
        question: parsed.type2.question,
        answer: parsed.type2.answer,
        source_thread_id: thread.threadId,
      })
    }

    return results
  } catch (error) {
    console.error(
      `Error generating Type 1&2 Q&A for thread ${thread.threadId}:`,
      error,
    )
    return []
  }
}

// Generate Type 3 Q&A: Group multiple threads and generate cross-thread question
async function generateType3QA(threads: Thread[]): Promise<QAOutput | null> {
  if (threads.length < 2) {
    return null
  }

  const threadsContext = threads
    .map((thread, idx) => {
      const messages = thread.messages
        .map((m) => `${m.name || m.username}: ${m.text}`)
        .join("\n")
      return `THREAD ${idx + 1} (ID: ${thread.threadId}):\n${messages}`
    })
    .join("\n\n---\n\n")

  const prompt = `You are an **EXPERT TEST DATA GENERATOR** for a Retrieval-Augmented Generation (RAG) system.
Your task is to create a high-quality, realistic question-answer pair by synthesizing information from multiple, distinct Slack conversations.

**CONTEXT:**
You are given ${threads.length} separate Slack threads. An employee will ask a question to an internal company chatbot, and the chatbot must use these threads as its knowledge base to provide a single, consolidated answer.

**SOURCE THREADS:**
${threadsContext}

**YOUR TASK:**
1.  **Synthesize, Don't Summarize:** Read all threads and identify a common theme, a point of comparison, or a connection between them.
2.  **Create a Realistic Question:**
    *   Formulate a question that an employee would realistically ask.
    *   The question **MUST** require information from **at least two** of the provided threads to be answered completely.
    *   The question **MUST NOT** be about the threads themselves (e.g., "Summarize thread 1" or "What is the difference between thread 1 and 2?"). It should be about the *content* of the threads.
    *   **Good Example:** "What were the key outcomes from the Q3 planning session, and how do they affect the upcoming product launch?" (This assumes one thread discusses planning outcomes and another discusses the launch).
    *   **Bad Example:** "Compare the conversations in Thread 1 and Thread 3."
3.  **Create a Factual Answer:**
    *   Write a concise and accurate answer based **ONLY** on the information present in the provided threads.
    *   Do not invent information or hallucinate.
    *   The answer should directly address the question you formulated.
4.  **Assign a Vagueness Score:**
    *   Rate the question's clarity from 0.0 (very specific) to 1.0 (very vague).
5.  **Format as JSON:** Return **ONLY** a single JSON object with the following structure. Do not add any other text or explanations.

{
  "question": "Your realistic, cross-thread question here.",
  "answer": "Your concise, factual answer synthesized from the threads.",
  "vagueness": 0.2
}`

  try {
    const response = await callLLM(prompt)

    let jsonStr = response.trim()
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      jsonStr = jsonMatch[0]
    }

    const parsed = JSON.parse(jsonStr)

    return {
      question_type: 3,
      vagueness: parsed.vagueness || 0.5,
      question: parsed.question,
      answer: parsed.answer,
      thread_ids: threads.map((t) => t.threadId),
    }
  } catch (error) {
    console.error(`Error generating Type 3 Q&A:`, error)
    return null
  }
}

// Shuffle array
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Append Q&A(s) to the output file, ensuring it's always a valid JSON array
async function appendQAsToFile(qas: QAOutput[], outputPath: string) {
  if (qas.length === 0) return

  let allQAs: QAOutput[] = []
  try {
    const currentData = await fs.readFile(outputPath, "utf-8")
    allQAs = JSON.parse(currentData)
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.error(`Error reading ${outputPath}, data may be lost.`, e)
    }
    // If file doesn't exist, it will be created by writeFile.
  }

  allQAs.push(...qas)

  await fs.writeFile(outputPath, JSON.stringify(allQAs, null, 2), "utf-8")
}

// Main function
async function main() {
  try {
    console.log("🚀 Starting Slack QA Generator...\n")

    // Load slack messages
    const messagesPath = path.join(__dirname, MESSAGES_FILE)
    const messagesContent = await fs.readFile(messagesPath, "utf-8")
    const messagesData: SlackMessagesData = JSON.parse(messagesContent)

    console.log(
      `📊 Loaded ${messagesData.threads.length} threads from ${MESSAGES_FILE}`,
    )

    const outputPath = path.join(__dirname, OUTPUT_FILE)
    // Initialize output file to ensure a clean run
    await fs.writeFile(outputPath, "[]", "utf-8")
    console.log(`🗑️  Initialized output file: ${outputPath}`)

    const allQAs: QAOutput[] = [] // Keep for final summary report

    // Filter threads with enough messages for Type 1 and Type 2
    const validThreads = messagesData.threads.filter(
      (t) => t.messages.length >= 3,
    )
    console.log(
      `✅ Found ${validThreads.length} threads valid for Type 1 & 2 (3+ messages)\n`,
    )

    console.log("📋 Generation Configuration:")
    console.log(
      `   Type 1 & 2: ${GENERATION_CONFIG.type1_2.enabled ? `${GENERATION_CONFIG.type1_2.count} threads` : "DISABLED"}`,
    )
    console.log(
      `   Type 3: ${GENERATION_CONFIG.type3.enabled ? `${GENERATION_CONFIG.type3.numGroups} groups of ${GENERATION_CONFIG.type3.threadsPerGroup} threads` : "DISABLED"}\n`,
    )

    // Generate Type 1 & 2 Q&As
    if (GENERATION_CONFIG.type1_2.enabled) {
      const shuffledValidThreads = shuffleArray(validThreads)
      const count = Math.min(
        GENERATION_CONFIG.type1_2.count,
        shuffledValidThreads.length,
      )

      console.log(
        `📝 Generating Type 1 & 2 Q&As for ${count} random threads...`,
      )
      for (let i = 0; i < count; i++) {
        const thread = shuffledValidThreads[i]
        console.log(
          `  Processing thread ${i + 1}/${count} (ID: ${thread.threadId})...`,
        )
        const qas = await generateType1And2QA(thread)

        if (qas.length > 0) {
          await appendQAsToFile(qas, outputPath)
          for (const qa of qas) {
            allQAs.push(qa)
            console.log(
              `  ✅ Generated and saved Q&A (Type ${qa.question_type})`,
            )
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000)) // Rate limiting
      }
    } else {
      console.log("⏭️  Type 1 & 2 generation disabled\n")
    }

    // Generate Type 3 Q&As (cross-thread questions)
    if (GENERATION_CONFIG.type3.enabled) {
      console.log(`\n📝 Generating Type 3 Q&As (cross-thread)...`)
      console.log(
        `  Configuration: ${GENERATION_CONFIG.type3.numGroups} groups, ${GENERATION_CONFIG.type3.threadsPerGroup} threads per group`,
      )

      const shuffledThreads = shuffleArray(messagesData.threads)
      let type3Success = 0

      for (let i = 0; i < GENERATION_CONFIG.type3.numGroups; i++) {
        const startIdx = i * GENERATION_CONFIG.type3.threadsPerGroup
        const endIdx = startIdx + GENERATION_CONFIG.type3.threadsPerGroup

        if (endIdx <= shuffledThreads.length) {
          const threadGroup = shuffledThreads.slice(startIdx, endIdx)
          console.log(
            `  Processing thread group ${i + 1}/${GENERATION_CONFIG.type3.numGroups} (${threadGroup.length} threads)...`,
          )
          const qa = await generateType3QA(threadGroup)
          if (qa) {
            await appendQAsToFile([qa], outputPath)
            allQAs.push(qa)
            type3Success++
            console.log(
              `  ✅ Generated and saved Type 3 Q&A (${type3Success} successful)`,
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 1000)) // Rate limiting
        } else {
          console.log(
            `  ⚠️  Not enough threads remaining for group ${i + 1}, skipping...`,
          )
        }
      }
    } else {
      console.log("⏭️  Type 3 generation disabled\n")
    }

    console.log(`\n✅ Successfully generated ${allQAs.length} Q&A pairs`)
    console.log(`📊 Breakdown:`)
    console.log(
      `   Type 1 (First message as question): ${allQAs.filter((qa) => qa.question_type === 1).length}`,
    )
    console.log(
      `   Type 2 (Analyze replies): ${allQAs.filter((qa) => qa.question_type === 2).length}`,
    )
    console.log(
      `   Type 3 (Cross-thread): ${allQAs.filter((qa) => qa.question_type === 3).length}`,
    )
    console.log(`\n💾 Output saved to: ${path.join(__dirname, OUTPUT_FILE)}`)
  } catch (error) {
    console.error("❌ Error in main:", error)
    process.exit(1)
  }
}

// Run the script
main()
