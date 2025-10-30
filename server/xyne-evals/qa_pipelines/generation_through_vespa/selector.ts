import { searchVespa } from "@/search/vespa"
import { VertexAI } from "@google-cloud/vertexai"
import * as dotenv from "dotenv"
import { generator } from "./generator.ts"

// Load environment variables
dotenv.config({ path: "../../server/.env" })

// Configuration from environment variables
const VertexProjectId = process.env.VERTEX_PROJECT_ID || "dev-ai-gamma"
const VertexRegion = process.env.VERTEX_REGION || "us-east5"
const VertexAIModel = "gemini-2.5-pro"

// Configuration
const RELEVANT_DOCS_LIMIT = 20
const QA_PAIRS_PER_DOC = 5
const TEST_EMAIL = "arshith.balaraju@juspay.in" // Test email for vespa queries

// New configuration for iterative filtering
const MAX_ITERATIONS = 3
const BATCH_SIZE = 20
const COHESIVENESS_THRESHOLD = 0.7

/**
 * Simple random document selection function
 */
function selectRandomDocument(docIds: string[]): string {
  if (docIds.length === 0) {
    throw new Error("Cannot select from empty document list")
  }

  const randomIndex = Math.floor(Math.random() * docIds.length)
  const selectedDocId = docIds[randomIndex]

  console.log(
    `🎲 Selector picked document ${randomIndex + 1}/${docIds.length}: ${selectedDocId}`,
  )

  return selectedDocId
}

/**
 * Extract meaningful terms from metadata fields
 */
function extractFromMetadataFields(fields: any): string[] {
  const extractedTerms: string[] = []

  // Priority order for field extraction
  const fieldPriority = [
    "title", // Highest priority - document titles
    "subject", // Email subjects
    "filename", // File names
    "name", // Entity names
    "description", // Event descriptions
  ]

  for (const field of fieldPriority) {
    if (
      fields[field] &&
      typeof fields[field] === "string" &&
      fields[field].trim()
    ) {
      const terms = extractMeaningfulTerms(fields[field])
      extractedTerms.push(...terms)

      // Stop after finding good metadata (prioritize quality over quantity)
      if (extractedTerms.length >= 3) break
    }
  }

  return extractedTerms
}

/**
 * Extract terms based on document type
 */
function extractByDocumentType(fields: any): string[] {
  const docType = fields.type

  switch (docType) {
    case "email":
      return extractEmailTerms(fields)
    case "slack":
      return extractSlackTerms(fields)
    case "file":
      return extractFileTerms(fields)
    case "event":
      return extractEventTerms(fields)
    default:
      return []
  }
}

/**
 * Extract email-specific terms
 */
function extractEmailTerms(fields: any): string[] {
  const terms: string[] = []

  // Focus on subject, sender patterns, action words
  if (fields.subject) {
    terms.push(...extractMeaningfulTerms(fields.subject))
  }

  // Extract action-oriented words from email context
  const actionWords = [
    "review",
    "approval",
    "meeting",
    "update",
    "request",
    "merge",
    "deploy",
  ]
  const emailText = (fields.text || fields.subject || "").toLowerCase()
  actionWords.forEach((word) => {
    if (emailText.includes(word)) {
      terms.push(word)
    }
  })

  return terms.slice(0, 3)
}

/**
 * Extract Slack-specific terms
 */
function extractSlackTerms(fields: any): string[] {
  const terms: string[] = []

  // Focus on channel context, mentions, hashtags
  if (fields.text) {
    // Extract mentions (@username)
    const mentions = fields.text.match(/@\w+/g) || []
    terms.push(...mentions.map((m: string) => m.substring(1)))

    // Extract hashtags if any
    const hashtags = fields.text.match(/#\w+/g) || []
    terms.push(...hashtags.map((h: string) => h.substring(1)))

    // Extract meaningful terms from text
    terms.push(...extractMeaningfulTerms(fields.text))
  }

  return terms.slice(0, 4)
}

/**
 * Extract file-specific terms
 */
function extractFileTerms(fields: any): string[] {
  const terms: string[] = []

  // Focus on file paths, project names, technical terms
  if (fields.filename) {
    // Extract project names from file paths
    const pathParts = fields.filename
      .split("/")
      .filter((part: string) => part.length > 2)
    terms.push(...pathParts)

    // Remove file extensions
    const nameWithoutExt = fields.filename.replace(
      /\.(js|ts|py|json|md|txt|csv)$/i,
      "",
    )
    terms.push(...extractMeaningfulTerms(nameWithoutExt))
  }

  if (fields.title) {
    terms.push(...extractMeaningfulTerms(fields.title))
  }

  return terms.slice(0, 3)
}

/**
 * Extract event-specific terms
 */
function extractEventTerms(fields: any): string[] {
  const terms: string[] = []

  // Focus on event titles, participants, agenda items
  if (fields.title || fields.name) {
    terms.push(...extractMeaningfulTerms(fields.title || fields.name))
  }

  if (fields.description) {
    terms.push(...extractMeaningfulTerms(fields.description))
  }

  // Extract meeting-related terms
  const meetingWords = [
    "sync",
    "standup",
    "review",
    "planning",
    "retrospective",
    "demo",
  ]
  const eventText = (fields.description || fields.title || "").toLowerCase()
  meetingWords.forEach((word) => {
    if (eventText.includes(word)) {
      terms.push(word)
    }
  })

  return terms.slice(0, 3)
}

/**
 * Extract meaningful terms from text
 */
function extractMeaningfulTerms(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Remove common noise patterns
      .replace(/\[.*?\]/g, " ") // Remove [brackets]
      .replace(/https?:\/\/\S+/g, " ") // Remove URLs
      .replace(/@\S+\.(com|net|org)/g, " ") // Remove email domains
      .replace(/\.(json|js|ts|py|md)$/g, " ") // Remove file extensions
      // Split and filter
      .split(/[^\w]+/)
      .filter((word) => word.length > 2)
      .filter((word) => !isCommonWord(word))
      .filter((word) => !isNoise(word))
      .slice(0, 5)
  ) // Limit terms
}

/**
 * Check if word is a common word
 */
function isCommonWord(word: string): boolean {
  const commonWords = [
    "the",
    "and",
    "for",
    "are",
    "but",
    "not",
    "you",
    "all",
    "can",
    "had",
    "her",
    "was",
    "one",
    "our",
    "out",
    "day",
    "get",
    "has",
    "him",
    "his",
    "how",
    "its",
    "may",
    "new",
    "now",
    "old",
    "see",
    "two",
    "who",
    "boy",
    "did",
    "does",
    "let",
    "put",
    "say",
    "she",
    "too",
    "use",
    "this",
    "that",
    "with",
    "from",
    "they",
    "have",
    "been",
    "will",
    "would",
    "could",
    "should",
  ]
  return commonWords.includes(word)
}

/**
 * Check if word is noise
 */
function isNoise(word: string): boolean {
  // Filter out pure numbers, single characters, etc.
  return /^\d+$/.test(word) || word.length === 1
}

/**
 * Build document context for LLM
 */
function buildDocumentContext(
  fields: any,
  metadataTerms: string[],
  contextualTerms: string[],
): string {
  const context = {
    documentType: fields.type,
    title: fields.title || null,
    subject: fields.subject || null,
    filename: fields.filename || null,
    name: fields.name || null,
    description: fields.description || null,
    extractedMetadata: metadataTerms,
    contextualTerms: contextualTerms,
  }

  return JSON.stringify(context, null, 2)
}

/**
 * Generate LLM filter query using Ollama
 */
async function generateLLMFilterQuery(
  documentContext: string,
  maxRetries = 3,
): Promise<string> {
  const prompt = `
You are an expert at creating search queries for document retrieval. Given this document context, generate an optimal search query that would find semantically related documents.

DOCUMENT_CONTEXT:
${documentContext}

REQUIREMENTS:
1. Create a focused search query (2-4 key terms)
2. Prioritize meaningful terms over noise (no random numbers, URLs, etc.)
3. Focus on themes, projects, people, technologies, or business concepts
4. Consider the document type when crafting the query
5. Aim for queries that will find related but diverse content

EXAMPLES:
- For email about "DPIP Dashboard Review": generate "DPIP dashboard review"
- For file "merchant-config.json": generate "merchant configuration"
- For Slack about "Xyne sync meeting": generate "xyne sync meeting"
- For event "Team Planning Session": generate "team planning session"

OUTPUT: Return ONLY the search query string, no explanation or formatting.
`

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🤖 Calling Ollama LLM for filter query generation (attempt ${attempt}/${maxRetries})...`,
      )

      const response = await fetch("https://ollama.pratikn.com/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama3.1:latest",
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.3,
            top_p: 0.8,
            max_tokens: 50,
          },
        }),
      })

      if (!response.ok) {
        throw new Error(
          `Ollama API error: ${response.status} ${response.statusText}`,
        )
      }

      const data = await response.json()
      let generatedQuery = data.response?.trim()

      if (!generatedQuery) {
        throw new Error("Empty response from Ollama LLM")
      }

      // Clean up the generated query
      generatedQuery = cleanGeneratedQuery(generatedQuery)

      if (generatedQuery.length > 0) {
        console.log(`✅ LLM generated filter query: "${generatedQuery}"`)
        return generatedQuery
      } else {
        throw new Error("Generated query is empty after cleaning")
      }
    } catch (error: any) {
      console.error(
        `❌ LLM filter query generation attempt ${attempt}/${maxRetries} failed:`,
        error.message,
      )

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000
        console.log(`⏳ Retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // Fallback: use rule-based extraction if LLM fails
  console.warn(
    "⚠️ LLM filter query generation failed, falling back to rule-based approach",
  )
  return fallbackFilterQuery(documentContext)
}

/**
 * Clean generated query
 */
function cleanGeneratedQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // Remove special characters
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .split(" ")
    .filter((word) => word.length > 2)
    .filter((word) => !/^\d+$/.test(word)) // Remove pure numbers
    .slice(0, 4) // Limit to 4 terms max
    .join(" ")
}

/**
 * Fallback filter query generation
 */
function fallbackFilterQuery(documentContext: string): string {
  // Parse the context and extract key terms using rule-based approach
  try {
    const context = JSON.parse(documentContext)
    const fallbackTerms = [
      ...(context.extractedMetadata || []),
      ...(context.contextualTerms || []),
    ].slice(0, 5)

    return fallbackTerms.join(" ") || "general search"
  } catch {
    return "general search"
  }
}

/**
 * Enhanced filter query generation with metadata + LLM
 */
async function generateFilterQuery(doc: any): Promise<string> {
  if (!doc || !doc.fields) {
    return "general search" // fallback
  }

  // Step 1: Extract metadata terms
  const metadataTerms = extractFromMetadataFields(doc.fields)

  // Step 2: Extract document type-specific terms
  const contextualTerms = extractByDocumentType(doc.fields)

  // Step 3: Build rich context for LLM
  const documentContext = buildDocumentContext(
    doc.fields,
    metadataTerms,
    contextualTerms,
  )

  // Step 4: Call Ollama LLM to generate optimal filter query
  const filterQuery = await generateLLMFilterQuery(documentContext)

  console.log(`🔍 Generated filter query: "${filterQuery}"`)
  return filterQuery
}

/**
 * Search vespa for relevant documents using filter query with offset
 */
async function searchVespaWithOffset(
  filterQuery: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  console.log(
    `🔎 Searching vespa with filter: "${filterQuery}" (limit=${limit}, offset=${offset})`,
  )

  try {
    const searchResults = await searchVespa(
      filterQuery,
      TEST_EMAIL,
      null, // app - search across all apps
      null, // entity - search across all entities
      {
        limit,
        offset,
      },
    )

    const results = searchResults?.root?.children || []
    console.log(`✅ Found ${results.length} documents (offset=${offset})`)
    return results
  } catch (error) {
    console.error("❌ Error searching vespa:", error)
    return []
  }
}

/**
 * Call LLM to filter documents for cohesiveness
 */
async function filterDocumentsForCohesiveness(
  documents: any[],
  referenceContext: any[],
  iterationNumber: number,
  maxRetries = 3,
): Promise<any[]> {
  console.log(
    `🤖 LLM filtering ${documents.length} documents (iteration ${iterationNumber})...`,
  )

  if (documents.length === 0) {
    return []
  }

  // Prepare reference context description
  let contextDescription = ""
  if (iterationNumber === 1) {
    // First iteration: use original selected document
    const originalDoc = referenceContext[0]
    contextDescription = `Original Selected Document: ${JSON.stringify(originalDoc).substring(0, 1000)}...`
  } else {
    // Later iterations: use previously filtered documents
    contextDescription = `Previously Filtered Documents (Iterations 1-${iterationNumber - 1}): ${JSON.stringify(referenceContext).substring(0, 2000)}...`
  }

  const cohesivenessPrompt = `
SYSTEM: You are a document cohesiveness analyzer performing iterative refinement.

ITERATION: ${iterationNumber}/${MAX_ITERATIONS}

REFERENCE_CONTEXT: 
${contextDescription}

NEW_BATCH_TO_FILTER: ${JSON.stringify(documents)}

TASK: Analyze each document in the new batch against the reference context. 
${
  iterationNumber === 1
    ? "Filter based on topical relevance to the original document."
    : "Filter based on coherence with the growing filtered collection."
}

Keep documents that:
1. Are thematically coherent with the reference context
2. Add meaningful value to the growing knowledge base
3. Maintain topical consistency across the collection

Remove documents that:
1. Are off-topic or unrelated
2. Introduce conflicting themes
3. Are redundant with existing content

OUTPUT_FORMAT: Return ONLY a JSON object with this exact structure:
{
  "filtered_documents": [
    {"docId": "doc1", "reason": "Highly relevant to main topic"},
    {"docId": "doc5", "reason": "Related project context"}
  ],
  "removed_documents": [
    {"docId": "doc2", "reason": "Off-topic discussion"},
    {"docId": "doc3", "reason": "Unrelated domain"}
  ],
  "summary": "Kept X/Y documents based on cohesiveness analysis"
}

IMPORTANT: Return ONLY the JSON object, no additional text or formatting.`

  let lastError: any
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔧 LLM filtering attempt ${attempt}/${maxRetries}...`)

      const vertexAI = new VertexAI({
        project: VertexProjectId,
        location: VertexRegion,
      })

      const generativeModel = vertexAI.getGenerativeModel({
        model: VertexAIModel,
        generationConfig: {
          temperature: 0.3,
          topP: 0.8,
          topK: 40,
        },
      })

      const contents = [
        {
          role: "user",
          parts: [{ text: cohesivenessPrompt }],
        },
      ]

      const response = await generativeModel.generateContent({ contents })

      // Wait for response completion
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

      // Parse the filtering response with robust JSON extraction
      let filterResult: any
      try {
        // Try direct JSON parse first
        filterResult = JSON.parse(content)
      } catch (e) {
        console.log(`🔧 Direct JSON parse failed, trying extraction methods...`)
        console.log(`📝 Raw LLM response: ${content.substring(0, 500)}...`)

        // Method 1: Try to extract JSON from markdown code block
        const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
        if (codeBlockMatch) {
          try {
            filterResult = JSON.parse(codeBlockMatch[1].trim())
            console.log(`✅ Successfully parsed JSON from code block`)
          } catch (innerE) {
            console.log(`❌ Failed to parse JSON from code block: ${innerE}`)
          }
        }

        // Method 2: Try to find JSON object boundaries
        if (!filterResult) {
          const jsonStartIndex = content.indexOf("{")
          const jsonEndIndex = content.lastIndexOf("}")

          if (
            jsonStartIndex !== -1 &&
            jsonEndIndex !== -1 &&
            jsonEndIndex > jsonStartIndex
          ) {
            const jsonStr = content.substring(jsonStartIndex, jsonEndIndex + 1)
            try {
              filterResult = JSON.parse(jsonStr)
              console.log(`✅ Successfully parsed JSON from boundaries`)
            } catch (innerE) {
              console.log(`❌ Failed to parse JSON from boundaries: ${innerE}`)
            }
          }
        }

        // Method 3: Try to clean and parse
        if (!filterResult) {
          // Remove common prefixes/suffixes and clean the response
          let cleanContent = content
            .replace(/^.*?(\{)/s, "$1") // Remove everything before first {
            .replace(/(\}).*$/s, "$1") // Remove everything after last }
            .replace(/\n/g, " ") // Replace newlines with spaces
            .replace(/\s+/g, " ") // Normalize whitespace
            .trim()

          try {
            filterResult = JSON.parse(cleanContent)
            console.log(`✅ Successfully parsed cleaned JSON`)
          } catch (innerE) {
            console.log(`❌ Failed to parse cleaned JSON: ${innerE}`)
          }
        }

        // Method 4: Try to build a valid JSON structure if we can extract key parts
        if (!filterResult) {
          console.log(
            `🔧 Attempting to construct JSON from response fragments...`,
          )

          // Look for patterns that might indicate filtered documents
          const docIdPattern = /"docId":\s*"([^"]+)"/g
          const reasonPattern = /"reason":\s*"([^"]+)"/g

          const docIdMatches = [...content.matchAll(docIdPattern)]
          const reasonMatches = [...content.matchAll(reasonPattern)]

          if (docIdMatches.length > 0) {
            // Try to construct a basic structure
            const filteredDocs = docIdMatches
              .slice(0, Math.min(docIdMatches.length, reasonMatches.length))
              .map((match, i) => ({
                docId: match[1],
                reason: reasonMatches[i]
                  ? reasonMatches[i][1]
                  : "Extracted from response",
              }))

            filterResult = {
              filtered_documents: filteredDocs,
              removed_documents: [],
              summary: `Extracted ${filteredDocs.length} documents from partial response`,
            }
            console.log(`✅ Constructed JSON from response fragments`)
          }
        }

        // If all methods fail, throw error
        if (!filterResult) {
          throw new Error(
            `Failed to parse JSON from LLM response. Raw response: ${content.substring(0, 200)}...`,
          )
        }
      }

      // Validate response structure
      if (
        !filterResult.filtered_documents ||
        !Array.isArray(filterResult.filtered_documents)
      ) {
        throw new Error("Invalid filter result structure")
      }

      // Extract filtered document IDs
      const filteredDocIds = new Set(
        filterResult.filtered_documents.map((doc: any) => doc.docId),
      )

      // Filter the original documents array
      const filteredDocs = documents.filter((doc) =>
        filteredDocIds.has(doc.fields?.docId || doc.id),
      )

      console.log(
        `✂️ LLM filtered ${documents.length} → ${filteredDocs.length} cohesive documents`,
      )
      console.log(
        `📋 Summary: ${filterResult.summary || "No summary provided"}`,
      )

      return filteredDocs
    } catch (err: any) {
      lastError = err
      console.error(
        `❌ LLM filtering attempt ${attempt}/${maxRetries} failed:`,
        err.message,
      )

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        console.log(`⏳ Retrying in ${Math.round(delay)}ms...`)
        await new Promise((res) => setTimeout(res, delay))
      }
    }
  }

  console.warn(
    `⚠️ LLM filtering failed after ${maxRetries} attempts, returning original documents`,
  )
  console.warn(`Last error: ${lastError?.message || "Unknown error"}`)
  return documents // Fallback: return original documents if filtering fails
}

/**
 * Iterative document collection with cascading contextual filtering
 */
async function iterativeDocumentCollection(
  filterQuery: string,
  selectedDocBody: string,
): Promise<{
  documents: any[]
  metadata: {
    totalIterations: number
    docsPerIteration: number[]
    filteredDocsPerIteration: number[]
    totalFiltered: number
  }
}> {
  console.log(
    "🔄 Starting iterative document collection with cascading filtering...",
  )

  let accumulatedFilteredDocs: any[] = []
  let currentReferenceContext: any[] = [
    { body: selectedDocBody, docId: "original_selected" },
  ]

  const docsPerIteration: number[] = []
  const filteredDocsPerIteration: number[] = []
  let completedIterations = 0

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const iterationNum = iteration + 1
    const offset = iteration * BATCH_SIZE

    console.log(
      `\n🔄 ITERATION ${iterationNum}/${MAX_ITERATIONS} (offset=${offset})`,
    )

    // Get next batch from Vespa
    const batchDocs = await searchVespaWithOffset(
      filterQuery,
      BATCH_SIZE,
      offset,
    )
    docsPerIteration.push(batchDocs.length)

    if (batchDocs.length === 0) {
      console.log(
        `📭 No more documents available at offset ${offset}, stopping iterations`,
      )
      break
    }

    // Extract and log document IDs to verify Vespa retrieval
    const retrievedDocIds = batchDocs
      .map((doc) => doc.fields?.docId || doc.id || "unknown")
      .filter((id) => id !== "unknown")
    console.log(
      `📄 Retrieved ${batchDocs.length}/${BATCH_SIZE} documents from Vespa`,
    )
    console.log(`📋 Retrieved Doc IDs: [${retrievedDocIds.join(", ")}]`)
    console.log(
      `🎯 Reference: ${iterationNum === 1 ? "Original selected document" : `${currentReferenceContext.length} previously filtered documents`}`,
    )

    // Filter using current reference context
    const filteredBatch = await filterDocumentsForCohesiveness(
      batchDocs,
      currentReferenceContext,
      iterationNum,
    )

    filteredDocsPerIteration.push(filteredBatch.length)

    // Accumulate results
    accumulatedFilteredDocs.push(...filteredBatch)

    console.log(
      `📚 Accumulated total: ${accumulatedFilteredDocs.length} documents`,
    )

    // Update reference context for next iteration (cascading effect)
    if (filteredBatch.length > 0) {
      currentReferenceContext = accumulatedFilteredDocs
    }

    // If no documents were filtered in this iteration, consider stopping
    if (filteredBatch.length === 0) {
      console.log(
        `⚠️ No documents passed filtering in iteration ${iterationNum}`,
      )
    }

    completedIterations = iterationNum
  }

  const metadata = {
    totalIterations: completedIterations,
    docsPerIteration,
    filteredDocsPerIteration,
    totalFiltered: accumulatedFilteredDocs.length,
  }

  console.log("\n📊 Iterative Collection Summary:")
  console.log(`  🔄 Total iterations: ${metadata.totalIterations}`)
  console.log(`  📄 Documents per iteration: ${docsPerIteration.join(", ")}`)
  console.log(
    `  ✂️ Filtered per iteration: ${filteredDocsPerIteration.join(", ")}`,
  )
  console.log(`  📚 Total accumulated: ${metadata.totalFiltered} documents`)

  return {
    documents: accumulatedFilteredDocs,
    metadata,
  }
}

/**
 * Enhanced selector function that handles group iteration and document processing
 */
export async function selector(
  docIds: string[],
  documentMap: Map<string, any>,
  numberOfGroups: number,
): Promise<void> {
  console.log(`🎯 Starting selector for ${numberOfGroups} groups...`)

  for (let groupIndex = 0; groupIndex < numberOfGroups; groupIndex++) {
    const groupNumber = groupIndex + 1

    console.log("")
    console.log("=".repeat(80))
    console.log(`🚀 PROCESSING GROUP ${groupNumber}/${numberOfGroups}`)
    console.log("=".repeat(80))

    try {
      // Step 1: Select random document
      const selectedDocId = selectRandomDocument(docIds)
      console.log(
        `🎯 GROUP ${groupNumber} - Selected document ID: ${selectedDocId}`,
      )

      // Step 2: Get document and body for selected document
      const selectedDoc = documentMap.get(selectedDocId)
      if (!selectedDoc) {
        throw new Error(
          `No document found for selected document: ${selectedDocId}`,
        )
      }

      const selectedDocBody = selectedDoc.body
      if (!selectedDocBody) {
        throw new Error(`No body found for selected document: ${selectedDocId}`)
      }

      console.log(
        `📄 GROUP ${groupNumber} - Selected document body preview: ${selectedDocBody.substring(0, 200)}...`,
      )

      // Step 3: Generate filter query from document
      const filterQuery = await generateFilterQuery(selectedDoc)

      // Step 4: Use iterative document collection with cascading filtering
      console.log(
        `🔄 GROUP ${groupNumber} - Starting iterative document collection with cascading contextual filtering...`,
      )
      const { documents: relevantDocs, metadata: iterationMetadata } =
        await iterativeDocumentCollection(filterQuery, selectedDocBody)

      if (relevantDocs.length === 0) {
        console.warn(
          `⚠️  GROUP ${groupNumber} - No relevant documents found after iterative filtering, using selected document only`,
        )
      }

      // Step 5: Call generator (fire-and-forget)
      console.log(
        `🤖 GROUP ${groupNumber} - Calling generator for QA generation...`,
      )
      await generator(
        relevantDocs.length > 0
          ? relevantDocs
          : [{ fields: { docId: selectedDocId } }],
        QA_PAIRS_PER_DOC,
        `group_${groupNumber}_${selectedDocId}`,
      )

      console.log(`✅ GROUP ${groupNumber} COMPLETED SUCCESSFULLY`)
      console.log(`📊 Selected Document: ${selectedDocId}`)
      console.log(`📄 Relevant Documents: ${relevantDocs.length}`)

      // Display iteration details for this group
      if (iterationMetadata) {
        console.log(
          `🔄 Filtering: ${iterationMetadata.docsPerIteration.join(", ")} → ${iterationMetadata.filteredDocsPerIteration.join(", ")} (${iterationMetadata.totalFiltered} total)`,
        )
      }

      // Small delay between groups to avoid overwhelming the system
      if (groupIndex < numberOfGroups - 1) {
        console.log(
          `⏳ Waiting 2 seconds before starting GROUP ${groupNumber + 1}...`,
        )
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (error) {
      console.error(`❌ GROUP ${groupNumber} FAILED:`, error)
      // Continue with other groups even if one fails
      continue
    }
  }

  console.log("")
  console.log("=".repeat(80))
  console.log("✅ ALL GROUPS COMPLETED")
  console.log("=".repeat(80))
}
