import { searchVespa, GetRandomDocument } from "@/search/vespa"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  fileSchema,
  mailSchema,
  userSchema,
  eventSchema,
  mailAttachmentSchema,
} from "@xyne/vespa-ts/types"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { Message } from "@aws-sdk/client-bedrock-runtime" // Required for provider interface
import config from "@/config"
import { getProviderByModel } from "@/ai/provider"
import type {
  LLMProvider,
  AIProviders as AIProvidersType,
  Models,
} from "@/ai/types" // Corrected imports
import { getSortedScoredChunks } from "@xyne/vespa-ts/mappers" // Import the sorter
import pLimit from "p-limit" // Added: Import p-limit
import { SearchModes } from "@xyne/vespa-ts/types"
// Configuration
const Logger = getLogger(Subsystem.Eval)
const USER_EMAIL_FOR_SEARCH = process.env.EVALUATION_USER_EMAIL

// --- Evaluation Mode ---
const EVAL_MODE = process.env.EVAL_MODE // 'generate' or 'evaluate'
const EVAL_DATASET_PATH = process.env.EVAL_DATASET_PATH // Required if EVAL_MODE='evaluate'
// --- End Evaluation Mode ---

if (!USER_EMAIL_FOR_SEARCH) {
  Logger.error("Error: Environment variable EVALUATION_USER_EMAIL is not set.")
  Logger.error("This email is required for permission-aware search evaluation.")
  Logger.error(
    "Please set it and run the script again. Example: EVALUATION_USER_EMAIL='user@example.com' bun run ...",
  )
  process.exit(1)
}
Logger.info(`Using email for search evaluation: ${USER_EMAIL_FOR_SEARCH}`)

const NUM_SAMPLES = parseInt(process.env.NUM_SAMPLES || "100", 10) // Samples = Documents to test
const QUERIES_PER_DOC = parseInt(process.env.QUERIES_PER_DOC || "1", 10) // LLM queries per document
const MAX_RANK_TO_CHECK = parseInt(process.env.MAX_RANK_TO_CHECK || "100", 10)
const HITS_PER_PAGE = 10
const VESPA_NAMESPACE = "namespace" // TODO: Replace with your actual Vespa namespace
const VESPA_CLUSTER_NAME = "my_content" // TODO: Replace with your actual cluster name
const DELAY_MS = parseInt(process.env.EVALUATION_DELAY_MS || "10", 10) // Increased default delay for LLM calls
const DEBUG_POOR_RANKINGS = process.env.DEBUG_POOR_RANKINGS === "true"
const POOR_RANK_THRESHOLD = parseInt(
  process.env.POOR_RANK_THRESHOLD || "10",
  10,
)
const OUTPUT_DIR = path.join(
  __dirname,
  "..",
  "eval-results",
  "search-quality-llm", // Separate output directory
)
const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || config.OllamaModel || config.defaultBestModel // Use the model from the central config or default best model
const ADVANCED_MODEL_NAME = process.env.ADVANCED_MODEL_NAME || "qwen3:30b-a3b" // Model name to trigger advanced prompt
const ADVANCED_PROMPT_CHUNKS = parseInt(
  process.env.ADVANCED_PROMPT_CHUNKS || "4",
  10,
) // Number of chunks for advanced prompt

const MAX_FETCH_RETRIES_PER_SAMPLE = 5 // Max attempts to find a suitable doc per sample
const MAX_LLM_RETRIES_PER_DOC = 3 // Max attempts to generate queries for a doc
const MAX_VERIFICATION_RETRIES = 3 // Added: Max attempts for verification LLM calls
const MAX_ANALYSIS_RETRIES = 3 // Max attempts for analysis LLM calls
const MAX_BODY_CHARS_FOR_PROMPT = 500 // Max characters of body snippet for standard prompt
const GENERATE_CONCURRENCY = parseInt(
  process.env.GENERATE_CONCURRENCY || "5",
  10,
) // Added: Concurrency limit

// Helper function to ensure directory exists
function ensureDirectoryExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    Logger.info(`Creating output directory: ${dirPath}`)
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

// Mapping from sddocname to relevant fields
const schemaFieldMap: Record<
  string,
  {
    idField: string
    titleField: string
    bodyField?: string
    metadataFields?: string[]
  } // Added metadataFields
> = {
  [fileSchema]: {
    idField: "docId",
    titleField: "title",
    bodyField: "chunks",
    metadataFields: ["owner", "createdAt", "updatedAt", "mimeType"],
  },
  [mailSchema]: {
    idField: "docId",
    titleField: "subject",
    bodyField: "chunks",
    metadataFields: ["from", "to", "timestamp", "labels"],
  },
  [userSchema]: {
    idField: "docId",
    titleField: "name",
    // No body field typically for users
    metadataFields: ["email", "orgJobTitle", "orgDepartment", "creationTime"],
  },
  [eventSchema]: {
    idField: "docId",
    titleField: "name",
    bodyField: "description",
    metadataFields: [
      "location",
      "startTime",
      "endTime",
      "organizer",
      "attendees",
    ],
  },
  [mailAttachmentSchema]: {
    idField: "docId",
    titleField: "filename",
    bodyField: "chunks",
    metadataFields: ["fileType", "timestamp", "partId"], // Added partId here as potentially useful metadata
  },
}

// Types
interface VespaFields extends Record<string, any> {
  sddocname?: string
}

interface Document {
  id: string // User-facing ID (e.g., email message ID, file ID)
  vespaId: string // Full Vespa document ID (e.g., id:namespace:schema::user_id)
  fields: VespaFields
}

interface DebugFailureInfo {
  docId: string // User-facing ID
  vespaId: string // Full Vespa ID
  query: string
  llmModel: string // Model used for query generation
  foundAtRank: number | null
  debugInfo: {
    query: string
    docIdToFind: string // User-facing ID
    vespaIdToFind: string // Full Vespa ID
    topResults: Array<{
      // Only top 10 results
      rank: number
      schema: string
      title: string
      docId: string // User-facing ID
      vespaId: string // Full Vespa ID
    }>
  }
}

interface Metrics {
  mrr: number
  ndcgAt10: number
  successAt1: number
  successAt3: number
  successAt5: number
  successAt10: number
  successRate: number
  rankDistribution: Record<string, number>
}

interface EvaluationDatasetItem {
  docId: string
  vespaId: string
  schema: string
  title: string
  llmModel: string
  queries: string[]
  sourceDocContext: {
    docId: string
    vespaId: string
    schema: string
    title: string
    metadataSnippet: Record<string, any>
    topNChunks?: string[]
  }
}

// DebugAnalysisEntry now only used internally within evaluateFromDataset
interface DebugAnalysisEntry {
  sourceDocContext: EvaluationDatasetItem["sourceDocContext"]
  evaluationFailure: DebugFailureInfo
}

// Copied from analyzePoorSearchRankingsLLM.ts
interface LLMAnalysisResult {
  assessment:
    | "GOOD_QUERY_RANKING_ISSUE"
    | "BAD_QUERY_IRRELEVANT"
    | "BAD_QUERY_TOO_GENERAL"
    | "BAD_QUERY_TOO_SPECIFIC"
    | "UNCLEAR"
    | "ERROR"
  reasoning: string
  confidence?: number
}

// Structure to hold analysis results alongside the entry
interface DetailedAnalysisResult {
  entry: DebugAnalysisEntry
  analysis: LLMAnalysisResult
}

// Define the structure of evaluation results explicitly
interface EvaluationResult {
  docId: string
  vespaId: string
  schema: string
  title: string
  rank: number | null
  query: string
  llmModel: string
}

// Added: Type for LLM Query Verification
interface LLMVerificationResult {
  assessment:
    | "GOOD_QUERIES"
    | "BAD_QUERIES_IRRELEVANT"
    | "BAD_QUERIES_GENERIC"
    | "BAD_QUERIES_OBSCURE"
    | "ERROR"
  reasoning: string
}

// Fetch random document from Vespa
async function getRandomDocument(): Promise<Document | null> {
  const schemas = Object.keys(schemaFieldMap)
  const targetSchema = schemas[Math.floor(Math.random() * schemas.length)]
  Logger.debug(`Fetching random document from schema: ${targetSchema}...`)

  try {
    const doc = await GetRandomDocument(
      VESPA_NAMESPACE,
      targetSchema,
      VESPA_CLUSTER_NAME,
    )

    // Basic validation of the response structure
    if (!doc || !doc.id || !doc.fields) {
      Logger.warn(
        { responseData: doc, schema: targetSchema },
        "Received invalid data structure from GetRandomDocument",
      )
      return null
    }

    const vespaId = doc.id // e.g., "id:namespace:schema::user_provided_id"
    const idParts = vespaId.split("::")
    // Infer user-facing ID from Vespa ID or fallback to docId field
    const userFacingId = idParts[1] || doc.fields.docId || vespaId
    const sddocname = doc.id.split(":")[2] || targetSchema // Infer schema from Vespa ID

    // More specific validation based on schema mapping
    const fieldMapping = schemaFieldMap[sddocname]
    if (!fieldMapping) {
      Logger.warn(
        { vespaId, inferredSchema: sddocname },
        "Cannot process document: Schema not found in schemaFieldMap",
      )
      return null
    }

    const idField = fieldMapping.idField
    const titleField = fieldMapping.titleField
    const docIdFromFields = doc.fields[idField]
    const titleFromFields = doc.fields[titleField]

    if (
      docIdFromFields === undefined ||
      docIdFromFields === null ||
      typeof titleFromFields !== "string" ||
      titleFromFields.trim() === ""
    ) {
      Logger.warn(
        {
          vespaId,
          sddocname,
          idField,
          titleField,
          docIdValue: docIdFromFields,
          titleValue: titleFromFields,
        },
        `Document missing required ID ('${idField}') or Title ('${titleField}') field, or title is empty. Skipping.`,
      )
      return null
    }

    // Ensure userFacingId consistency if possible
    if (String(docIdFromFields) !== userFacingId && idParts[1]) {
      Logger.debug(
        { vespaId, userFacingId, idField, docIdFromFields },
        `User-facing ID from Vespa ID ('${userFacingId}') differs from field '${idField}' ('${docIdFromFields}'). Using ID from field.`,
      )
    }

    // Return the structured document
    return {
      id: userFacingId, // Use the ID inferred from Vespa ID structure or field map
      vespaId: vespaId,
      fields: { ...(doc.fields as VespaFields), sddocname },
    }
  } catch (error) {
    Logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        schema: targetSchema,
      },
      "Failed to get random document",
    )
    return null
  }
}

// Generate search queries using Ollama Provider - MODIFIED
async function generateSearchQueries(
  doc: Document,
  modelToUse: string,
): Promise<{
  queries: string[]
  sourceDocContext?: EvaluationDatasetItem["sourceDocContext"] | null
}> {
  // Return queries AND context
  const fields = doc.fields as VespaFields
  const sddocname = fields.sddocname

  if (!sddocname || !schemaFieldMap[sddocname]) {
    Logger.warn(
      { docId: doc.id, sddocname },
      "Cannot generate query: Unknown schema",
    )
    return { queries: [], sourceDocContext: null }
  }

  const { titleField, bodyField, metadataFields } = schemaFieldMap[sddocname]
  const title = fields[titleField] as string | undefined

  if (!title || title.trim() === "") {
    Logger.warn(
      { docId: doc.id, sddocname, titleField },
      `Cannot generate query: Missing or empty title field ('${titleField}')`,
    )
    return { queries: [], sourceDocContext: null }
  }

  // Prepare metadata snippet for both prompt and debug context
  const metadataSnippet: Record<string, any> = {}
  if (metadataFields) {
    metadataFields.forEach((key) => {
      if (fields[key] !== undefined && fields[key] !== null) {
        // Basic cleanup/shortening for potentially long metadata like attendees
        if (Array.isArray(fields[key]) && fields[key].length > 5) {
          metadataSnippet[key] = fields[key].slice(0, 5).join(", ") + "..."
        } else if (Array.isArray(fields[key])) {
          metadataSnippet[key] = fields[key].join(", ")
        } else {
          metadataSnippet[key] = fields[key]
        }
      }
    })
  }

  // Prepare top N chunks for both prompt and debug context
  let topChunksText = "No content chunks available."
  let chunks_summary: string[] = []
  if (fields.matchfeatures && Array.isArray(fields.chunks_summary)) {
    chunks_summary = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary,
    ).map((c) => c.chunk)
  } else if (Array.isArray(fields.chunks)) {
    chunks_summary = fields.chunks // Use as is if no matchfeatures
  } else if (sddocname == "event") {
    chunks_summary = [fields.description]
  } else if (sddocname == "user") {
    chunks_summary = [fields.name + " " + fields.email]
  }
  // Use chunks if available for the prompt, limit to a reasonable number if too many
  const chunksForPrompt = chunks_summary.slice(0, 10) // Limit to 10 chunks for prompt clarity

  if (chunksForPrompt.length > 0) {
    topChunksText = chunksForPrompt
      .map(
        (chunk, index) => `--- Chunk ${index + 1} ---
${chunk}`,
      )
      .join("\n")
  }

  if (!chunks_summary.length) {
    return { queries: [], sourceDocContext: null }
  }

  // --- NEW SYSTEM AND USER PROMPT ---
  const systemPrompt = `You are an expert search user trying to find a specific document. Based ONLY on the provided document context below, generate ${QUERIES_PER_DOC} diverse, realistic search queries that a user might type to find this exact document.`

  const sourceDocContextForPrompt = {
    //   docId: doc.id,
    //   vespaId: doc.vespaId,
    //   schema: sddocname,
    title: title,
    //   metadataSnippet,
    // Include chunks in the prompt context if available
    body: chunksForPrompt.length > 0 ? chunksForPrompt : undefined,
  }

  const userPrompt = `**Instructions:**
Generate ${QUERIES_PER_DOC} realistic search queries a user might type to find the document described in the Context below.

1.  **Focus:** Queries should focus on keywords, concepts, or natural language questions related to the document's title, metadata, or content chunks.
2.  **Realism:** Queries should resemble common search engine inputs. Avoid overly specific phrases unlikely to be searched.
3.  **Conciseness:** Aim for queries that are typically 3 to 7 words long.
4.  **Context:** Use ONLY information present in the \`Document Context\` below. Do NOT invent details.
5.  **Body:** Use the \`Body\` field in the \`Document Context\` below to generate queries as well
6.  **Format:** Output ONLY a valid JSON array string containing exactly ${QUERIES_PER_DOC} query strings.
    * Example of desired JSON array output:
      ["weekly securities statement", "invoice pdf", "flight to bangkok", "ethical hacking course", "report from september 20", "digital ocean invoice"]
    * DO NOT include any other text, explanations, reasoning, or formatting outside the single JSON array string.

**Document Context:**
\`\`\`json
${JSON.stringify(sourceDocContextForPrompt, null, 2)}
\`\`\`

/no_think
`
  // --- END NEW SYSTEM AND USER PROMPT ---

  // Prepare messages for the Ollama provider
  const messages: Message[] = [
    { role: "user", content: [{ text: userPrompt }] },
  ]

  Logger.debug(
    { docId: doc.id, model: modelToUse },
    "Sending request via OllamaProvider",
  )

  try {
    // --- Use central Provider getter ---
    const ollamaProvider = getProviderByModel(modelToUse as Models) as
      | LLMProvider
      | undefined

    if (!ollamaProvider) {
      Logger.error(
        { configuredModel: modelToUse },
        "Configuration Error: Ollama provider could not be initialized or found.",
      )
      return { queries: [], sourceDocContext: null }
    }

    const response = await ollamaProvider.converse(messages, {
      modelId: modelToUse as Models,
      systemPrompt: systemPrompt,
      temperature: 0.8, // Increased temperature for more diverse queries
      stream: false,
    })

    // --- Response Parsing (MODIFIED for newline-separated queries) ---
    if (!response || !response.text || response.text.trim() === "") {
      Logger.warn(
        { docId: doc.id, responseData: response },
        "Received empty or invalid response from OllamaProvider",
      )
      return { queries: [], sourceDocContext: null }
    }

    Logger.trace(
      { docId: doc.id, responseText: response.text },
      "Raw response from OllamaProvider",
    )

    let generatedQueries: string[] = []
    try {
      // --- Clean the response text first (remove potential ```json wrappers) ---
      let cleanedResponseText = response.text.trim()
      // Remove potential markdown code fences
      cleanedResponseText = cleanedResponseText
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/, "")
      // Remove potential leading/trailing non-JSON characters if any remain (be careful not to strip actual JSON)
      const startIndex = cleanedResponseText.indexOf("[")
      const endIndex = cleanedResponseText.lastIndexOf("]")
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        throw new Error(
          "Could not find JSON array start/end brackets in the cleaned response.",
        )
      }
      const jsonString = cleanedResponseText.substring(startIndex, endIndex + 1)
      // --- End Cleaning ---

      const parsedJson = JSON.parse(jsonString)

      if (!Array.isArray(parsedJson)) {
        throw new Error(
          `LLM response was not a JSON array. Got: ${typeof parsedJson}`,
        )
      }

      // Validate that elements are strings
      if (!parsedJson.every((item) => typeof item === "string")) {
        throw new Error(
          `Not all elements in the parsed JSON array were strings.`,
        )
      }

      generatedQueries = parsedJson

      // Optional: Check if the count matches (can be tricky if LLM doesn't always obey)
      if (generatedQueries.length !== QUERIES_PER_DOC) {
        Logger.warn(
          {
            docId: doc.id,
            expected: QUERIES_PER_DOC,
            generated: generatedQueries.length,
          },
          `LLM generated ${generatedQueries.length} queries, but ${QUERIES_PER_DOC} were requested.`,
        )
        // Decide if you want to proceed with the incorrect count or return null
        // For now, we'll proceed but log the warning.
        // If you want to enforce the count strictly, you could uncomment the next line:
        // throw new Error(`LLM did not generate the exact number of queries requested (${QUERIES_PER_DOC}). Got ${generatedQueries.length}.`);
      }

      // Filter out empty strings just in case
      generatedQueries = generatedQueries.filter((q) => q.trim().length > 0)

      if (generatedQueries.length === 0) {
        Logger.warn(
          { docId: doc.id, rawResponse: response.text },
          "LLM generated no valid query strings in the JSON array.",
        )
        return { queries: [], sourceDocContext: null }
      }
    } catch (parseError: any) {
      Logger.error(
        {
          docId: doc.id,
          error: parseError.message,
          rawResponse: response.text,
        },
        "Failed to parse JSON array response from OllamaProvider",
      )
      return { queries: [], sourceDocContext: null }
    }
    // --- End Response Parsing ---

    Logger.debug(
      { docId: doc.id, queries: generatedQueries },
      "LLM generated queries successfully via Provider",
    )
    const sourceDocContext: EvaluationDatasetItem["sourceDocContext"] = {
      docId: doc.id,
      vespaId: doc.vespaId,
      schema: sddocname,
      title: title,
      metadataSnippet,
      // Store all chunks in the sourceDocContext for potential analysis
      topNChunks: chunks_summary.length > 0 ? chunks_summary : undefined,
    }
    return { queries: generatedQueries, sourceDocContext }
  } catch (error: any) {
    Logger.error(
      {
        docId: doc.id,
        model: modelToUse,
        error: error.message || String(error),
      },
      "Failed to generate queries using OllamaProvider",
    )
    return { queries: [], sourceDocContext: null }
  }
}

// Find the rank of a specific document for a given query
async function findDocumentRank(
  docIdToFind: string, // User-facing ID
  vespaIdToFind: string, // Full Vespa ID
  query: string,
  alpha: number, // Added: Alpha value for hybrid search
  modelToUse: string, // Added: Model being used
): Promise<{ rank: number | null; debugPayload: DebugFailureInfo | null }> {
  Logger.debug(
    { docIdToFind, vespaIdToFind, query, alpha },
    "findDocumentRank called",
  )

  let rank: number | null = null
  let offset = 0
  let collectedDebugInfo: DebugFailureInfo | null = null // Store full debug info here if debugging is enabled

  try {
    while (offset < MAX_RANK_TO_CHECK) {
      const searchOptions: Record<string, any> = {
        limit: HITS_PER_PAGE,
        offset: offset,
        rankProfile: SearchModes.NativeRank, // Or your custom hybrid rank profile name
        // Corrected: Pass alpha using the key expected by searchVespa in vespa.ts
        alpha,
        ...(DEBUG_POOR_RANKINGS ? { tracelevel: 5 } : {}), // Enable trace only if debugging
      }

      // Assuming searchVespa takes the query string directly
      const response = await searchVespa(
        query,
        USER_EMAIL_FOR_SEARCH!,
        null, // filters
        null, // groupBy
        searchOptions,
      )

      const hits = response.root.children || []
      const totalCount = response.root.fields?.totalCount || 0

      // --- Debug Info Collection (if enabled) ---
      if (DEBUG_POOR_RANKINGS) {
        // Collect debug info for each page if debugging is enabled
        // This ensures we have info even if the poor rank is on a later page or not found
        if (!collectedDebugInfo) {
          // Initialize only on the first page or if an error cleared it
          collectedDebugInfo = {
            // Create the basic structure
            docId: docIdToFind,
            vespaId: vespaIdToFind,
            query: query,
            llmModel: modelToUse,
            foundAtRank: null, // Placeholder, updated if found
            debugInfo: {
              query: query,
              docIdToFind: docIdToFind,
              vespaIdToFind: vespaIdToFind,
              topResults: [], // Will populate with hits from current page
            },
          }
        }

        // Append hits from the current page to topResults (up to 10 per page)
        const pageTopResults = hits
          .slice(0, 10)
          .map((hit: any, index: number) => {
            const currentRank = offset + index + 1
            const hitVespaId = hit.id || "unknown_vespa_id"
            const fields = hit.fields as VespaFields
            const sddocname =
              fields?.sddocname || hitVespaId.split(":")[2] || "unknown"
            const fieldMapping = schemaFieldMap[sddocname]
            let hitUserFacingId = "unknown_user_id"
            let hitTitle = "unknown_title"

            if (fieldMapping) {
              hitUserFacingId = fields?.[fieldMapping.idField]
                ? String(fields[fieldMapping.idField])
                : hitVespaId.split("::")[1] || hitVespaId
              hitTitle = fields?.[fieldMapping.titleField]
                ? String(fields[fieldMapping.titleField])
                : "unknown_title"
            } else {
              // Fallback if schema unknown
              hitUserFacingId = hitVespaId.split("::")[1] || hitVespaId
            }

            return {
              rank: currentRank,
              schema: sddocname,
              title: hitTitle,
              docId: hitUserFacingId,
              vespaId: hitVespaId,
            }
          })
        // Only keep up to 10 results total in topResults to match DebugFailureInfo structure expectation
        collectedDebugInfo.debugInfo.topResults =
          collectedDebugInfo.debugInfo.topResults
            .concat(pageTopResults)
            .slice(0, 10)

        // Note: Trace is still omitted here for brevity, but could be added if needed from response.root.trace
      }
      // --- End Debug Info Collection ---

      if (hits.length === 0) {
        break // No more hits from Vespa
      }

      // Check hits on the current page
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]
        const currentRank = offset + i + 1
        const hitVespaId = hit.id // Get the full Vespa ID from the hit

        Logger.trace(
          { rank: currentRank, hitVespaId, vespaIdToFind },
          "Comparing hit Vespa ID",
        )

        // Compare using the full Vespa ID for accuracy
        if (hitVespaId && hitVespaId === vespaIdToFind) {
          rank = currentRank
          Logger.debug(
            `---> Match found at rank ${rank}! Vespa ID: ${vespaIdToFind}`,
          )
          // Update rank in collected debug info if it exists
          if (collectedDebugInfo) {
            collectedDebugInfo.foundAtRank = rank
          }
          break // Exit inner loop once found
        }
      }

      if (rank !== null) {
        break // Exit outer loop once found
      }

      offset += HITS_PER_PAGE

      // Stop if we've checked all available documents reported by Vespa or reached MAX_RANK_TO_CHECK limit
      if (
        totalCount > 0 &&
        offset >= totalCount &&
        totalCount <= MAX_RANK_TO_CHECK
      ) {
        Logger.debug(
          { docIdToFind, totalCount, offset },
          `Stopped pagination: Checked all ${totalCount} available documents reported by Vespa.`,
        )
        break
      } else if (
        offset >= MAX_RANK_TO_CHECK &&
        totalCount > MAX_RANK_TO_CHECK
      ) {
        Logger.debug(
          { docIdToFind, totalCount, offset, MAX_RANK_TO_CHECK },
          `Stopped pagination: Reached MAX_RANK_TO_CHECK limit, but more total hits available.`,
        )
        break
      } else if (totalCount === 0 && offset > 0) {
        Logger.debug(
          { docIdToFind, offset },
          "Stopped pagination: No total count reported and no hits returned on current page.",
        )
        break
      }
    } // End while loop

    // --- Save Individual Debug File REMOVED ---
  } catch (error) {
    Logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to search for document rank due to error",
    )
    // If an error occurred, ensure basic debug info exists if debugging is on
    if (DEBUG_POOR_RANKINGS && !collectedDebugInfo) {
      collectedDebugInfo = {
        docId: docIdToFind,
        vespaId: vespaIdToFind,
        query: query,
        llmModel: modelToUse,
        foundAtRank: null, // Indicate error/unknown rank
        debugInfo: {
          // Basic info available
          query: query,
          docIdToFind: docIdToFind,
          vespaIdToFind: vespaIdToFind,
          topResults: [], // No results due to error
        },
      }
    }
    // Return null rank and the potentially partial debug info
    return { rank: null, debugPayload: collectedDebugInfo }
  }

  // Return rank and the debug payload IF debugging is enabled and rank is poor/null
  // The full list of collectedDebugInfo is always passed back if debugging is on.
  return {
    rank,
    debugPayload:
      DEBUG_POOR_RANKINGS &&
      (rank === null || (rank !== null && rank > POOR_RANK_THRESHOLD))
        ? collectedDebugInfo // Return the collected debug info
        : null, // Return null if not debugging or rank is good
  }
}

// Calculate evaluation metrics - MODIFIED to accept EvaluationResult[]
function calculateMetrics(results: EvaluationResult[]): Metrics {
  const numResults = results.length
  if (numResults === 0) {
    // Return zero metrics if no results to process
    return {
      mrr: 0,
      ndcgAt10: 0,
      successAt1: 0,
      successAt3: 0,
      successAt5: 0,
      successAt10: 0,
      successRate: 0,
      rankDistribution: {
        "1": 0,
        "2-3": 0,
        "4-5": 0,
        "6-10": 0,
        "11-20": 0,
        "21-50": 0,
        "51-100": 0,
        not_found: 0,
      },
    }
  }

  const reciprocalRanks: number[] = []
  const ndcgAt10Scores: number[] = [] // Added: Array to store individual NDCG@10 scores
  const idealDcgAt10 = 1 / Math.log2(1 + 1) // IDCG for a single relevant item at rank 1
  const rankDistribution: Record<string, number> = {
    "1": 0,
    "2-3": 0,
    "4-5": 0,
    "6-10": 0,
    "11-20": 0,
    "21-50": 0,
    "51-100": 0,
    not_found: 0,
  }
  let successAt1Count = 0
  let successAt3Count = 0
  let successAt5Count = 0
  let successAt10Count = 0
  let successRateCount = 0 // Within MAX_RANK_TO_CHECK

  results.forEach((result) => {
    const rank = result.rank
    let currentNdcgAt10 = 0 // Added: Variable for current query's NDCG

    if (rank !== null && rank <= MAX_RANK_TO_CHECK) {
      reciprocalRanks.push(1 / rank)
      successRateCount++
      if (rank <= 10) {
        const dcg = 1 / Math.log2(rank + 1) // Calculate DCG for this query
        currentNdcgAt10 = idealDcgAt10 > 0 ? dcg / idealDcgAt10 : 0 // Calculate NDCG for this query
        successAt10Count++
        if (rank <= 5) {
          successAt5Count++
          if (rank <= 3) {
            successAt3Count++
            if (rank === 1) {
              successAt1Count++
            }
          }
        }
      }
      if (rank === 1) rankDistribution["1"]++
      else if (rank <= 3) rankDistribution["2-3"]++
      else if (rank <= 5) rankDistribution["4-5"]++
      else if (rank <= 10) rankDistribution["6-10"]++
      else if (rank <= 20) rankDistribution["11-20"]++
      else if (rank <= 50) rankDistribution["21-50"]++
      else rankDistribution["51-100"]++
    } else {
      // Do not add to reciprocalRanks or ndcgAt10Scores if not found
      rankDistribution["not_found"]++
    }
    // Only push scores for found items to the temporary arrays for averaging
    if (rank !== null && rank <= MAX_RANK_TO_CHECK) {
      ndcgAt10Scores.push(currentNdcgAt10)
    }
  })

  const calculateMean = (arr: number[]): number => {
    if (arr.length === 0) return 0
    const sum = arr.reduce((acc, val) => acc + val, 0)
    return sum / arr.length
  }

  // Filter out not found cases before calculating mean for MRR and NDCG@10
  const foundResults = results.filter(
    (result) => result.rank !== null && result.rank <= MAX_RANK_TO_CHECK,
  )
  const mrr = calculateMean(foundResults.map((result) => 1 / result.rank!)) // Calculate mean of reciprocal ranks for found items
  const ndcgAt10 = calculateMean(
    foundResults.map((result) => {
      // Recalculate NDCG for found items if needed, or use the stored currentNdcgAt10
      // For simplicity and consistency with original logic, let's use the stored one.
      // We need to find the corresponding stored NDCG score for this result.
      // A better approach might be to store objects {rank: number, ndcg: number} initially.
      // For now, let's recalculate based on rank for found items.
      const rank = result.rank!
      const dcg = 1 / Math.log2(rank + 1)
      return idealDcgAt10 > 0 ? dcg / idealDcgAt10 : 0
    }),
  )

  return {
    mrr: mrr,
    ndcgAt10: ndcgAt10,
    successAt1: successAt1Count / numResults,
    successAt3: successAt3Count / numResults,
    successAt5: successAt5Count / numResults,
    successAt10: successAt10Count / numResults,
    successRate: successRateCount / numResults,
    rankDistribution,
  }
}

// --- Analysis Function (Adapted from analyzePoorSearchRankingsLLM.ts) ---
async function analyzePoorRankingCase(
  entry: DebugAnalysisEntry,
  llmProvider: LLMProvider,
  modelToUse: string,
): Promise<LLMAnalysisResult> {
  // Use modelToUse from parameter for analysis model
  const analysisModel = modelToUse as Models
  const { sourceDocContext, evaluationFailure } = entry
  const { query, foundAtRank, debugInfo } = evaluationFailure // Already checked for null before calling this
  const { topResults } = debugInfo || {} // debugInfo might still be minimal if search errored

  Logger.debug(
    { docId: sourceDocContext.docId, query },
    "Analyzing poor ranking case...",
  )

  const sourceContextString = `Source Document:\n- Title: "${sourceDocContext.title}"\n- Schema: ${sourceDocContext.schema}\n- Metadata: ${JSON.stringify(sourceDocContext.metadataSnippet)}\n${sourceDocContext.topNChunks ? `- Relevant Chunks:\n${sourceDocContext.topNChunks.map((c, i) => `  - Chunk ${i + 1}: ${c.substring(0, 150)}...`).join("\n")}` : "- No chunks available"}\n`

  const searchResultsString = `Search Results for Query "${query}":\n- Target document was found at rank: ${foundAtRank ?? "Not Found"}\n- Top 10 results:\n${topResults?.map((r) => `  - Rank ${r.rank}: "${r.title}" (Schema: ${r.schema}, DocID: ${r.docId}, VespaID: ${r.vespaId})`).join("\n") || "N/A"}\n`

  const systemPrompt = `You are an expert search quality analyst. Your task is to analyze why a specific search query performed poorly for finding a target document, given the document's content, the query, and the search results. Provide a concise analysis and categorization.`
  const userPrompt = `Please analyze the following search quality failure case:\n\n${sourceContextString}\n\nGenerated Query (that performed poorly):\n"${query}"\n\n${searchResultsString}\n\nAnalysis Task:\n1. Evaluate the query: Is "${query}" a reasonable and relevant query someone might use to find the Source Document described above? Consider its specificity and keywords.\n2. Analyze the search results: Given the query and the source document, are the top search results relevant? Why might the target document have ranked poorly (at ${foundAtRank ?? "Not Found"}) or not appeared?\n3. Categorize the failure: Based on your analysis, choose the *best* fitting category from the list below.\n\nCategories:\n- GOOD_QUERY_RANKING_ISSUE: The query was reasonable and relevant, but the search engine failed to rank the target document highly.\n- BAD_QUERY_IRRELEVANT: The query was not relevant to the source document's content.\n- BAD_QUERY_TOO_GENERAL: The query was relevant but too broad, likely matching many other documents.\n- BAD_QUERY_TOO_SPECIFIC: The query was too specific or used terms unlikely to be searched, even if related to the document.\n- UNCLEAR: Not enough information to determine the cause of the poor ranking.\n\nOutput Format:\nReturn *only* a valid JSON object with the keys "assessment" (containing the chosen category string) and "reasoning" (a brief explanation for your assessment, 1-2 sentences). Example:\n{\n  "assessment": "GOOD_QUERY_RANKING_ISSUE",\n  "reasoning": "The query uses relevant keywords from the title and chunks. The target document should have ranked higher given the query."\n}\n\nDO NOT include any other text, explanations, or formatting outside the JSON object.`

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_ANALYSIS_RETRIES; attempt++) {
    try {
      Logger.debug(
        { docId: sourceDocContext.docId, query, attempt },
        `LLM Analysis Attempt ${attempt}/${MAX_ANALYSIS_RETRIES}`,
      )
      const response = await llmProvider.converse(
        [{ role: "user", content: [{ text: userPrompt }] }],
        {
          modelId: analysisModel,
          systemPrompt: systemPrompt,
          temperature: 0.3,
          stream: false,
        },
      )

      if (!response || !response.text)
        throw new Error("LLM response was empty.")
      Logger.trace(
        {
          docId: sourceDocContext.docId,
          query,
          attempt,
          responseText: response.text,
        },
        "Raw LLM analysis response",
      )

      let cleanedResponseText = response.text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim()
      cleanedResponseText = cleanedResponseText
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/g, "")
        .trim()

      // --- More Robust JSON Object Extraction ---
      const startIndex = cleanedResponseText.indexOf("{")
      const endIndex = cleanedResponseText.lastIndexOf("}")
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        throw new Error(
          "Could not find JSON object start/end braces in the cleaned response.",
        )
      }
      const jsonString = cleanedResponseText.substring(startIndex, endIndex + 1)
      // --- End Robust Extraction ---

      const parsedJson = JSON.parse(jsonString) // Parse the extracted string

      if (
        typeof parsedJson.assessment !== "string" ||
        typeof parsedJson.reasoning !== "string"
      ) {
        throw new Error(
          "Parsed JSON does not match the expected LLMAnalysisResult structure.",
        )
      }
      const validAssessments: LLMAnalysisResult["assessment"][] = [
        "GOOD_QUERY_RANKING_ISSUE",
        "BAD_QUERY_IRRELEVANT",
        "BAD_QUERY_TOO_GENERAL",
        "BAD_QUERY_TOO_SPECIFIC",
        "UNCLEAR",
      ]
      if (!validAssessments.includes(parsedJson.assessment)) {
        Logger.warn(
          { parsedAssessment: parsedJson.assessment },
          "LLM returned an unexpected assessment category.",
        )
      }

      Logger.debug(
        {
          docId: sourceDocContext.docId,
          query,
          assessment: parsedJson.assessment,
        },
        "LLM analysis successful.",
      )
      return parsedJson as LLMAnalysisResult
    } catch (error: any) {
      lastError = error
      Logger.warn(
        {
          docId: sourceDocContext.docId,
          query,
          attempt,
          error: error?.message,
        },
        `LLM analysis attempt ${attempt} failed. Retrying after delay...`,
      )
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS * attempt))
    }
  }

  Logger.error(
    { docId: sourceDocContext.docId, query, error: lastError?.message },
    `LLM analysis failed after ${MAX_ANALYSIS_RETRIES} attempts.`,
  )
  return {
    assessment: "ERROR",
    reasoning: `Failed after ${MAX_ANALYSIS_RETRIES} attempts: ${lastError?.message || "Unknown error"}`,
  }
}
// --- End Analysis Function ---

// Generate the summary report
function generateSummaryReport(
  metrics: Metrics,
  totalQueriesEvaluated: number,
  totalDocsInDataset: number,
  analysisResults: DetailedAnalysisResult[],
  datasetPath?: string,
  modelUsed?: string,
): string {
  const {
    mrr,
    ndcgAt10,
    successAt1,
    successAt3,
    successAt5,
    successAt10,
    successRate,
    rankDistribution,
  } = metrics
  const formatPercent = (value: number) => (value * 100).toFixed(2)

  let report = `
=================================================
 SEARCH QUALITY EVALUATION SUMMARY
=================================================
Generated: ${new Date().toISOString()}
`
  if (datasetPath)
    report += `Evaluation Dataset: ${path.basename(datasetPath)}\n`
  report += `LLM Model Used: ${modelUsed || "Unknown"}
`
  report += `Target Documents in Dataset: ${totalDocsInDataset}
`
  report += `Total Queries Evaluated From Dataset: ${totalQueriesEvaluated}
`
  report += `Max Rank Checked per Query: ${MAX_RANK_TO_CHECK}
`
  report += `Poor Rank Threshold (for Debugging): ${POOR_RANK_THRESHOLD}
`
  report += `
---------------------
 OVERALL METRICS
---------------------
`
  report += `Mean Reciprocal Rank (MRR): ${mrr.toFixed(4)}
`
  report += `NDCG@10: ${ndcgAt10.toFixed(4)}
` // NOTE: Verify NDCG calculation if needed
  report += `
---------------------
 SUCCESS RATES (Precision@K)
---------------------
`
  report += `Found @ Rank 1:   ${formatPercent(successAt1)}% (${rankDistribution["1"]} queries)\n`
  report += `Found @ Rank <= 3:  ${formatPercent(successAt3)}% (${rankDistribution["1"] + rankDistribution["2-3"]} queries)\n`
  report += `Found @ Rank <= 5:  ${formatPercent(successAt5)}% (${rankDistribution["1"] + rankDistribution["2-3"] + rankDistribution["4-5"]} queries)\n`
  report += `Found @ Rank <= 10: ${formatPercent(successAt10)}% (${rankDistribution["1"] + rankDistribution["2-3"] + rankDistribution["4-5"] + rankDistribution["6-10"]} queries)\n`
  report += `Found @ Rank <= ${MAX_RANK_TO_CHECK}: ${formatPercent(successRate)}% (${totalQueriesEvaluated - rankDistribution["not_found"]} queries)\n`
  report += `
---------------------
 DISTRIBUTION OF RANKS (for ${totalQueriesEvaluated} queries)
---------------------
`
  const totalFound = totalQueriesEvaluated - rankDistribution["not_found"]
  for (const [bin, count] of Object.entries(rankDistribution)) {
    report += `Rank ${bin.padEnd(10)}: ${String(count).padStart(5)} (${formatPercent(count / totalQueriesEvaluated)}%)\n`
  }

  // --- Add Analysis Summary Section --- (if DEBUG_POOR_RANKINGS was true)
  if (DEBUG_POOR_RANKINGS && analysisResults.length > 0) {
    report += `
---------------------
 POOR RANKING ANALYSIS SUMMARY (${analysisResults.length} cases analyzed)
---------------------
`
    const analysisCounts: Record<LLMAnalysisResult["assessment"], number> = {
      GOOD_QUERY_RANKING_ISSUE: 0,
      BAD_QUERY_IRRELEVANT: 0,
      BAD_QUERY_TOO_GENERAL: 0,
      BAD_QUERY_TOO_SPECIFIC: 0,
      UNCLEAR: 0,
      ERROR: 0,
    }
    analysisResults.forEach((res) => {
      if (res.analysis && res.analysis.assessment) {
        analysisCounts[res.analysis.assessment]++
      }
    })

    for (const [assessment, count] of Object.entries(analysisCounts)) {
      const percentage =
        analysisResults.length > 0
          ? ((count / analysisResults.length) * 100).toFixed(1)
          : "0.0"
      report += `${assessment.padEnd(28)}: ${count} (${percentage}%)\n`
    }
    report += `\n(See analysis_details_*.json for full details if saved)\n`
  } else if (DEBUG_POOR_RANKINGS) {
    report += `
---------------------
 POOR RANKING ANALYSIS
---------------------
Debugging enabled, but no poor rankings were analyzed (check thresholds and logs).
`
  }
  // --- End Analysis Summary Section ---

  report += `
=================================================
 END OF REPORT
=================================================
`
  return report
}

// --- Added: LLM Query Verification Function ---
async function verifyGeneratedQueries(
  sourceDocContext: EvaluationDatasetItem["sourceDocContext"],
  generatedQueries: string[],
  llmProvider: LLMProvider,
  modelToUse: string,
): Promise<LLMVerificationResult> {
  const { title, schema, metadataSnippet, topNChunks } = sourceDocContext
  const queriesString = generatedQueries.map((q) => `\"${q}\"`).join(", ")

  Logger.debug(
    { docId: sourceDocContext.docId, queries: generatedQueries },
    "Verifying generated queries...",
  )

  const sourceContextString = `Source Document:\n- Title: \"${title}\"\n- Schema: ${schema}\n- ${topNChunks ? `- Relevant Chunks:\n${topNChunks.map((c, i) => `  - Chunk ${i + 1}: ${c.substring(0, 150)}...`).join("\n")}` : "- No chunks available"}\n`

  const systemPrompt = `You are an expert search quality analyst. Your task is to evaluate if a set of generated search queries are relevant, specific, and resemble queries a real user might use to find the given source document.`
  const userPrompt = `Please evaluate the following search queries intended to find the source document described below:\n\n${sourceContextString}\n\nGenerated Queries:\n[${queriesString}]\n\nVerification Task:\n1. Assess Relevance: Are the queries clearly related to the document's title, or content chunks?\n2. Assess Specificity: Are the queries specific enough to likely find this document, or are they too generic (could match many things) or too obscure (unlikely to be searched)?\n3. Categorize the Quality: Based on your assessment, choose the *best* fitting category from the list below.\n\nCategories:\n- GOOD_QUERIES: The queries are relevant, reasonably specific, and seem like plausible user searches for this document.\n- BAD_QUERIES_IRRELEVANT: Most queries are not relevant to the source document's content.\n- BAD_QUERIES_GENERIC: The queries are relevant but too broad/generic, likely matching many other documents.\n- BAD_QUERIES_OBSCURE: The queries might be relevant but are too specific or use terms/phrases unlikely to be searched by a real user.\n\nOutput Format:\nReturn *only* a valid JSON object with the keys "assessment" (containing the chosen category string) and "reasoning" (a brief explanation for your assessment, 1-2 sentences). Example:\n{\n  "assessment": "GOOD_QUERIES",\n  "reasoning": "Queries use relevant keywords from title and include plausible natural language questions."\n}\n\nDO NOT include any other text, explanations, or formatting outside the JSON object.`

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_VERIFICATION_RETRIES; attempt++) {
    try {
      Logger.debug(
        { docId: sourceDocContext.docId, attempt },
        `LLM Verification Attempt ${attempt}/${MAX_VERIFICATION_RETRIES}`,
      )
      const response = await llmProvider.converse(
        [{ role: "user", content: [{ text: userPrompt }] }],
        {
          modelId: modelToUse as Models,
          systemPrompt: systemPrompt,
          temperature: 0.3,
          stream: false,
        },
      )

      if (!response || !response.text)
        throw new Error("LLM response was empty.")
      Logger.trace(
        { docId: sourceDocContext.docId, attempt, responseText: response.text },
        "Raw LLM verification response",
      )

      let cleanedResponseText = response.text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim()
      cleanedResponseText = cleanedResponseText
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/g, "")
        .trim()
      const jsonMatch = cleanedResponseText.match(/(\{.*?\})/s)
      if (!jsonMatch || !jsonMatch[0])
        throw new Error("No JSON object found in the cleaned LLM response.")
      const parsedJson = JSON.parse(jsonMatch[0])

      if (
        typeof parsedJson.assessment !== "string" ||
        typeof parsedJson.reasoning !== "string"
      ) {
        throw new Error(
          "Parsed JSON does not match the expected LLMVerificationResult structure.",
        )
      }
      // Optional: Add validation for assessment values if needed

      Logger.debug(
        { docId: sourceDocContext.docId, assessment: parsedJson.assessment },
        "LLM verification successful.",
      )
      return parsedJson as LLMVerificationResult
    } catch (error: any) {
      lastError = error
      Logger.warn(
        { docId: sourceDocContext.docId, attempt, error: error?.message },
        `LLM verification attempt ${attempt} failed. Retrying after delay...`,
      )
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS * attempt))
    }
  }

  Logger.error(
    { docId: sourceDocContext.docId, error: lastError?.message },
    `LLM verification failed after ${MAX_VERIFICATION_RETRIES} attempts.`,
  )
  return {
    assessment: "ERROR",
    reasoning: `Failed after ${MAX_VERIFICATION_RETRIES} attempts: ${lastError?.message || "Unknown error"}`,
  }
}
// --- End Verification Function ---

// --- Added: Function to process a single sample (fetch -> generate -> verify) ---
async function processSingleSample(
  sampleIndex: number,
  totalSamples: number,
  queryGenProvider: LLMProvider,
  modelToUse: string,
): Promise<EvaluationDatasetItem | null> {
  Logger.debug(
    `--- Starting attempt for Verified Sample ${sampleIndex + 1}/${totalSamples} ---`,
  )

  let doc: Document | null = null
  let foundSuitableDocument = false

  // 1. Attempt to find a suitable document
  for (
    let fetchAttempt = 1;
    fetchAttempt <= MAX_FETCH_RETRIES_PER_SAMPLE;
    fetchAttempt++
  ) {
    doc = await getRandomDocument()
    if (doc) {
      foundSuitableDocument = true
      Logger.debug(
        `[Sample ${sampleIndex + 1}] Found candidate document (ID: ${doc.id})`,
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2)) // Wait before retry
  }

  if (!foundSuitableDocument || !doc) {
    Logger.warn(
      `[Sample ${sampleIndex + 1}] Failed to fetch a suitable document after ${MAX_FETCH_RETRIES_PER_SAMPLE} attempts. Skipping this sample attempt.`,
    )
    return null // Failed to get a document for this sample
  }

  // 2. Attempt to generate queries for the found document
  let generatedResult: {
    queries: string[]
    sourceDocContext?: EvaluationDatasetItem["sourceDocContext"] | null
  } = { queries: [], sourceDocContext: null }
  let generatedQueriesForDoc = false
  for (
    let genAttempt = 1;
    genAttempt <= MAX_LLM_RETRIES_PER_DOC;
    genAttempt++
  ) {
    generatedResult = await generateSearchQueries(doc, modelToUse)
    if (
      generatedResult.queries.length >= QUERIES_PER_DOC &&
      generatedResult.sourceDocContext
    ) {
      generatedQueriesForDoc = true
      break
    }
    if (
      generatedResult.queries.length > 0 &&
      genAttempt === MAX_LLM_RETRIES_PER_DOC
    ) {
      Logger.warn(
        `[Sample ${sampleIndex + 1}] Generated only ${generatedResult.queries.length}/${QUERIES_PER_DOC} queries for Doc ID ${doc.id}, using partial list.`,
      )
      generatedQueriesForDoc = true
      break
    }
    Logger.warn(
      `[Sample ${sampleIndex + 1}] Query Gen Attempt ${genAttempt} failed or insufficient queries for Doc ID ${doc.id}. Retrying...`,
    )
    await new Promise((resolve) =>
      setTimeout(resolve, DELAY_MS * (genAttempt + 1)),
    ) // Longer delay for retries
  }

  if (!generatedQueriesForDoc || !generatedResult.sourceDocContext) {
    Logger.warn(
      `[Sample ${sampleIndex + 1}] Failed to generate sufficient queries or capture context for Doc ID ${doc.id}. Skipping sample.`,
    )
    return null // Failed generation
  }

  // 3. Verify Generated Queries
  const verificationResult = await verifyGeneratedQueries(
    generatedResult.sourceDocContext,
    generatedResult.queries,
    queryGenProvider,
    modelToUse,
  )
  if (verificationResult.assessment !== "GOOD_QUERIES") {
    Logger.warn(
      {
        docId: doc.id,
        assessment: verificationResult.assessment,
        reason: verificationResult.reasoning,
      },
      `[Sample ${sampleIndex + 1}] Generated queries failed verification for Doc ID ${doc.id}. Skipping sample.`,
    )
    return null // Failed verification
  }

  Logger.info(
    `[Sample ${sampleIndex + 1}] Generated queries VERIFIED as GOOD for Doc ID ${doc.id}.`,
  )

  // 4. Return verified dataset item
  const verifiedItem: EvaluationDatasetItem = {
    docId: doc.id,
    vespaId: doc.vespaId,
    schema: generatedResult.sourceDocContext.schema,
    title: generatedResult.sourceDocContext.title,
    llmModel: modelToUse,
    queries: generatedResult.queries,
    sourceDocContext: generatedResult.sourceDocContext,
  }

  return verifiedItem
}
// --- End processSingleSample ---

// --- Generate Dataset Function (MODIFIED for Concurrency) ---
async function generateEvaluationDataset(): Promise<void> {
  Logger.info(`Starting dataset generation for ${NUM_SAMPLES} documents...`)
  Logger.info(
    `Using Ollama Model from config: ${OLLAMA_MODEL || config.defaultBestModel}`,
  )
  Logger.info(`Concurrency Level: ${GENERATE_CONCURRENCY}`)
  Logger.info(`Output directory: ${OUTPUT_DIR}`)

  const modelToUse = OLLAMA_MODEL || config.defaultBestModel
  if (!modelToUse) {
    Logger.error(
      "Error: No LLM model is configured. Please set up an AI provider (Vertex AI, AWS, OpenAI, etc.).",
    )
    process.exit(1)
  }
  const queryGenProvider = getProviderByModel(modelToUse as Models) as
    | LLMProvider
    | undefined
  if (!queryGenProvider) {
    Logger.error(
      { model: modelToUse },
      "Failed to initialize LLM provider for query generation/verification.",
    )
    process.exit(1)
  }

  ensureDirectoryExists(OUTPUT_DIR)

  const limit = pLimit(GENERATE_CONCURRENCY)
  const tasks: Promise<EvaluationDatasetItem | null>[] = []

  Logger.info(`Queueing ${NUM_SAMPLES} sample generation tasks...`)
  for (let i = 0; i < NUM_SAMPLES; i++) {
    // Wrap processSingleSample call in the limiter
    tasks.push(
      limit(() =>
        processSingleSample(i, NUM_SAMPLES, queryGenProvider, modelToUse),
      ),
    )
  }

  // Wait for all tasks to settle (either resolve or reject)
  const results = await Promise.allSettled(tasks)

  // Filter out failed attempts and collect successful dataset items
  const dataset: EvaluationDatasetItem[] = []
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      dataset.push(result.value)
      Logger.info(
        `[✓ Sample ${index + 1}/${NUM_SAMPLES}] Successfully generated and verified.`,
      )
    } else {
      // Log rejection reason or null value
      const reason =
        result.status === "rejected"
          ? result.reason
          : "Processing failed or returned null"
      Logger.error(
        `[✗ Sample ${index + 1}/${NUM_SAMPLES}] Failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      )
    }
  })

  const documentsSuccessfullyProcessed = dataset.length

  Logger.info(`--- Dataset Generation Finished ---`)
  Logger.info(
    `Successfully generated and verified ${documentsSuccessfullyProcessed} dataset entries out of ${NUM_SAMPLES} attempts.`,
  )

  // Save the dataset file if any entries were successful
  if (dataset.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const modelNameForFilename = modelToUse.replace(/:/g, ".")
    const datasetFilename = path.join(
      OUTPUT_DIR,
      `evaluation_dataset_${modelNameForFilename}_${timestamp}.json`,
    )
    try {
      fs.writeFileSync(datasetFilename, JSON.stringify(dataset, null, 2))
      Logger.info(
        `Evaluation dataset (${documentsSuccessfullyProcessed} entries) saved to: ${datasetFilename}`,
      )
    } catch (error) {
      Logger.error({ error }, "Failed to save evaluation dataset file.")
    }
  } else {
    Logger.warn(
      "No documents were successfully processed and verified, dataset file not saved.",
    )
  }
}

// --- Evaluate From Dataset Function (MODIFIED for alpha testing) ---
async function evaluateFromDataset(
  datasetPath: string,
  alpha: number,
): Promise<Metrics | null> {
  // Added alpha, return Metrics | null
  Logger.info(
    `Starting evaluation from dataset: ${datasetPath} with alpha=${alpha}`,
  ) // Log alpha
  if (!fs.existsSync(datasetPath)) {
    Logger.error(`Dataset file not found: ${datasetPath}`)
    process.exit(1)
  }

  let dataset: EvaluationDatasetItem[]
  try {
    const fileContent = fs.readFileSync(datasetPath, "utf-8")
    dataset = JSON.parse(fileContent)
    if (!Array.isArray(dataset) || dataset.length === 0) {
      throw new Error("Dataset file is empty or not a valid JSON array.")
    }
    Logger.info(`Loaded ${dataset.length} documents from dataset.`)
  } catch (error: any) {
    Logger.error(
      { error: error.message },
      `Failed to load or parse dataset file: ${datasetPath}`,
    )
    process.exit(1)
  }

  const firstItemModel = dataset[0]?.llmModel || "Unknown"
  Logger.info(`Dataset generated with LLM Model: ${firstItemModel}`)
  Logger.info(`Evaluation using LLM Model: ${firstItemModel}`) // Use the model from dataset
  Logger.info(`Output directory: ${OUTPUT_DIR}`)
  if (DEBUG_POOR_RANKINGS) {
    Logger.warn(
      `Debugging enabled: Poor rankings (rank > ${POOR_RANK_THRESHOLD} or not found) will be analyzed using LLM.`,
    )
  }

  ensureDirectoryExists(OUTPUT_DIR)
  let analysisLLMProvider: LLMProvider | undefined
  if (DEBUG_POOR_RANKINGS) {
    analysisLLMProvider = getProviderByModel(firstItemModel as Models) as
      | LLMProvider
      | undefined
    if (!analysisLLMProvider) {
      Logger.error(
        { model: firstItemModel },
        "Failed to initialize LLM provider for analysis. Analysis will be skipped.",
      )
    }
  }

  const evaluationResults: EvaluationResult[] = []
  const analysisResults: DetailedAnalysisResult[] = []
  let totalQueriesEvaluated = 0
  const limit = pLimit(GENERATE_CONCURRENCY) // Use p-limit for concurrency control
  const tasks: Promise<void>[] = []
  const processingResults: Array<{
    evalResult: EvaluationResult | null
    analysisResult: DetailedAnalysisResult | null
    error?: any
  }> = []

  Logger.info(
    `Starting parallel evaluation with concurrency: ${GENERATE_CONCURRENCY}`,
  )

  // Flatten the dataset items and queries into individual tasks
  const allQueriesTasks: Array<{
    item: EvaluationDatasetItem
    query: string
    docIndex: number
  }> = []
  dataset.forEach((item, docIndex) => {
    if (item.queries && item.queries.length > 0) {
      item.queries.forEach((query) => {
        allQueriesTasks.push({ item, query, docIndex })
      })
    } else {
      Logger.warn(
        { docId: item.docId },
        `[Doc ${docIndex + 1}] Skipping document with no queries in dataset.`,
      )
    }
  })

  totalQueriesEvaluated = allQueriesTasks.length
  Logger.info(
    `Prepared ${totalQueriesEvaluated} individual query evaluation tasks.`,
  )

  // Define the function to process a single query
  const processQuery = async (taskData: {
    item: EvaluationDatasetItem
    query: string
    docIndex: number
  }): Promise<{
    evalResult: EvaluationResult
    analysisResult: DetailedAnalysisResult | null
  }> => {
    const { item, query, docIndex } = taskData
    Logger.info(
      `[Alpha: ${alpha}, Doc ${docIndex + 1}/${dataset.length}] Evaluating Query: "${query.substring(0, 80)}${query.length > 80 ? "..." : ""}" for Doc ID: ${item.docId}`,
    )

    // Pass alpha to findDocumentRank
    const { rank, debugPayload } = await findDocumentRank(
      item.docId,
      item.vespaId,
      query,
      alpha,
      item.llmModel, // Use the model from the dataset item
    )

    const evalResult: EvaluationResult = {
      docId: item.docId,
      vespaId: item.vespaId,
      schema: item.schema,
      title: item.title,
      rank: rank,
      query: query,
      llmModel: item.llmModel,
    }

    let analysisResult: DetailedAnalysisResult | null = null

    // Perform Analysis if Poor Rank
    if (DEBUG_POOR_RANKINGS && debugPayload && analysisLLMProvider) {
      if (item.sourceDocContext) {
        const analysisEntry: DebugAnalysisEntry = {
          sourceDocContext: item.sourceDocContext,
          evaluationFailure: debugPayload,
        }
        Logger.info(
          `[Doc ${docIndex + 1}] -> Poor Rank (${rank ?? "Not Found"}) for Query "${query.substring(0, 30)}...". Performing LLM analysis...`,
        )
        const analysis = await analyzePoorRankingCase(
          analysisEntry,
          analysisLLMProvider,
          item.llmModel, // Use the model from the dataset item
        )
        analysisResult = { entry: analysisEntry, analysis }
        Logger.info(
          `[Doc ${docIndex + 1}] -> Analysis Complete. Assessment: ${analysis.assessment}`,
        )
      } else {
        Logger.warn(
          { docId: item.docId, query, rank },
          "[Doc ${docIndex + 1}] Poor rank detected but sourceDocContext is missing in dataset entry. Cannot perform analysis.",
        )
      }
    } else if (
      DEBUG_POOR_RANKINGS &&
      (rank === null || (rank !== null && rank > POOR_RANK_THRESHOLD)) &&
      !debugPayload
    ) {
      Logger.warn(
        { docId: item.docId, query, rank },
        "[Doc ${docIndex + 1}] Poor rank detected but debug payload was not generated (check findDocumentRank logic). Cannot perform analysis.",
      )
    } else if (
      DEBUG_POOR_RANKINGS &&
      (rank === null || (rank !== null && rank > POOR_RANK_THRESHOLD)) &&
      !analysisLLMProvider
    ) {
      Logger.warn(
        { docId: item.docId, query, rank, alpha },
        "[Alpha: ${alpha}, Doc ${docIndex + 1}] Poor rank detected but analysis LLM provider failed to initialize. Skipping analysis.",
      )
    }

    Logger.info(
      `[Alpha: ${alpha}, Doc ${docIndex + 1}] -> Query "${query.substring(0, 30)}..." Rank: ${rank ?? "Not Found (or > " + MAX_RANK_TO_CHECK + ")"}`,
    )
    return { evalResult, analysisResult }
  }

  // Queue tasks using p-limit
  allQueriesTasks.forEach((taskData) => {
    tasks.push(
      limit(async () => {
        try {
          const result = await processQuery(taskData)
          processingResults.push(result)
        } catch (error: any) {
          Logger.error(
            {
              docId: taskData.item.docId,
              query: taskData.query,
              error: error?.message,
            },
            "Error during parallel query processing",
          )
          processingResults.push({
            evalResult: null,
            analysisResult: null,
            error: error,
          }) // Store error indicator
        }
      }),
    )
  })

  // Wait for all tasks to complete
  await Promise.allSettled(tasks)

  // Collect results from processed tasks
  processingResults.forEach((res) => {
    if (res.evalResult) {
      evaluationResults.push(res.evalResult)
    }
    if (res.analysisResult) {
      analysisResults.push(res.analysisResult)
    }
    // Errors already logged within the task
  })

  Logger.info(`--- [Alpha: ${alpha}] Parallel Evaluation Finished ---`)
  Logger.info(`Documents Considered: ${dataset.length}`) // Changed log message slightly
  Logger.info(`Total Queries Evaluated: ${totalQueriesEvaluated}`)
  Logger.info(`Successful Evaluations: ${evaluationResults.length}`)
  Logger.info(`Analyses Performed (if enabled): ${analysisResults.length}`)

  if (totalQueriesEvaluated === 0 || evaluationResults.length === 0) {
    // Check evaluationResults too
    Logger.warn(
      `[Alpha: ${alpha}] No queries were successfully evaluated from the dataset. Cannot calculate metrics.`,
    )
    return null // Return null if no results
  }

  const metrics = calculateMetrics(evaluationResults)
  Logger.info(
    `--- [Alpha: ${alpha}] Final Metrics (from Dataset: ${path.basename(datasetPath)}) ---`,
  )
  Logger.info(`MRR: ${metrics.mrr.toFixed(4)}`)
  Logger.info(`NDCG@10: ${metrics.ndcgAt10.toFixed(4)}`)
  Logger.info(`Success@1: ${(metrics.successAt1 * 100).toFixed(2)}%`)
  Logger.info(`Success@10: ${(metrics.successAt10 * 100).toFixed(2)}%`)
  Logger.info(
    `Found Rate (<= ${MAX_RANK_TO_CHECK}): ${(metrics.successRate * 100).toFixed(2)}%`,
  )

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const datasetName = path.basename(datasetPath, ".json")
  const modelNameForFilename = firstItemModel.replace(/:/g, ".")

  // ---- REMOVED FILE WRITING FOR OPTIMIZATION RUN ----
  // try {
  //     const resultsFilename = path.join(OUTPUT_DIR, `eval_results_${datasetName}_${modelNameForFilename}_${timestamp}.json`);
  //     fs.writeFileSync(resultsFilename, JSON.stringify(evaluationResults, null, 2));
  //     Logger.info(`Detailed evaluation results saved to ${resultsFilename}`);

  //     const summaryFilename = path.join(OUTPUT_DIR, `summary_${datasetName}_${modelNameForFilename}_${timestamp}.txt`);
  //     const summaryContent = generateSummaryReport(metrics, totalQueriesEvaluated, dataset.length, analysisResults, datasetPath);
  //     fs.writeFileSync(summaryFilename, summaryContent);
  //     Logger.info(`Summary report saved to ${summaryFilename}`);
  //     Logger.info("--- Summary Report --- ");
  //     summaryContent.split('\n').forEach(line => Logger.info(line.trim()));

  //     if (analysisResults.length > 0) {
  //         const analysisDetailsFilename = path.join(OUTPUT_DIR, `analysis_details_${datasetName}_${modelNameForFilename}_${timestamp}.json`);
  //         fs.writeFileSync(analysisDetailsFilename, JSON.stringify(analysisResults, null, 2));
  //         Logger.info(`Detailed analysis results saved to ${analysisDetailsFilename}`);
  //     }
  // } catch (error) {
  //     Logger.error({ error }, "Failed to save one or more output files");
  // }
  // ---- END REMOVED FILE WRITING ----
  return metrics // Return calculated metrics
}

// --- Added: Function to Optimize Alpha ---
async function optimizeAlpha(datasetPath: string): Promise<void> {
  Logger.info("--- Starting Alpha Optimization --- ")
  Logger.info(`Using dataset: ${datasetPath}`)

  const alphaValues = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] // Define range to test
  const results: Array<{ alpha: number; metrics: Metrics | null }> = []

  let bestAlpha = -1
  let bestMetrics: Metrics | null = null

  for (const alpha of alphaValues) {
    Logger.info(`--- Running evaluation for alpha = ${alpha} ---`)
    const currentMetrics = await evaluateFromDataset(datasetPath, alpha)
    results.push({ alpha, metrics: currentMetrics })

    if (currentMetrics) {
      Logger.info(
        ` Alpha ${alpha}: MRR = ${currentMetrics.mrr.toFixed(4)}, NDCG@10 = ${currentMetrics.ndcgAt10.toFixed(4)}`,
      )

      // Determine if current metrics are better than the best found so far
      // Prioritize NDCG@10, then MRR as tie-breaker
      let isBetter = false
      if (!bestMetrics) {
        isBetter = true // First successful run is the best so far
      } else {
        if (currentMetrics.ndcgAt10 > bestMetrics.ndcgAt10) {
          isBetter = true
        } else if (
          currentMetrics.ndcgAt10 === bestMetrics.ndcgAt10 &&
          currentMetrics.mrr > bestMetrics.mrr
        ) {
          isBetter = true
        }
      }

      if (isBetter) {
        Logger.info(` --> New best metrics found for alpha = ${alpha}`)
        bestMetrics = currentMetrics
        bestAlpha = alpha
      }
    } else {
      Logger.warn(` --> Evaluation failed for alpha = ${alpha}`)
    }
    Logger.info(`--- Finished evaluation for alpha = ${alpha} ---`)
  }

  Logger.info("--- Alpha Optimization Finished --- ")
  Logger.info("Optimization Summary:")
  results.forEach((res) => {
    if (res.metrics) {
      Logger.info(
        `  Alpha ${res.alpha.toFixed(1)}: MRR = ${res.metrics.mrr.toFixed(4)}, NDCG@10 = ${res.metrics.ndcgAt10.toFixed(4)}`,
      )
    } else {
      Logger.info(`  Alpha ${res.alpha.toFixed(1)}: Evaluation Failed`)
    }
  })

  if (bestAlpha !== -1 && bestMetrics) {
    Logger.info(`\nBEST Alpha Found: ${bestAlpha.toFixed(1)}`)
    Logger.info(`  Best MRR:     ${bestMetrics.mrr.toFixed(4)}`)
    Logger.info(`  Best NDCG@10: ${bestMetrics.ndcgAt10.toFixed(4)}`)
  } else {
    Logger.warn("\nNo successful evaluation run completed during optimization.")
  }
}
// --- End Optimize Alpha Function ---

// Main function to orchestrate the evaluation
async function mainEvaluationRouter() {
  // Add a check for OLLAMA_MODEL in config for 'generate' mode
  if (EVAL_MODE === "generate") {
    // The check is now inside generateEvaluationDataset
    await generateEvaluationDataset()
  } else if (EVAL_MODE === "evaluate") {
    if (!EVAL_DATASET_PATH) {
      Logger.error(
        "Error: EVAL_MODE is 'evaluate' but EVAL_DATASET_PATH environment variable is not set.",
      )
      Logger.error(
        "Please set EVAL_DATASET_PATH to the path of the .json dataset file.",
      )
      process.exit(1)
    }
    // When running 'evaluate' mode directly, use a default alpha (e.g., 0.5)
    // Or you could require an ALPHA env var here as well.
    const defaultAlpha = parseFloat(process.env.DEFAULT_ALPHA || "0.5")
    Logger.warn(
      `Running single evaluation with alpha=${defaultAlpha}. Set DEFAULT_ALPHA env var to change.`,
    )
    const metrics = await evaluateFromDataset(EVAL_DATASET_PATH, defaultAlpha)
    // We need to manually generate the report here if needed, as evaluateFromDataset no longer does.
    if (metrics) {
      // Load dataset to get the model info
      let firstItemModel = "Unknown"
      try {
        const fileContent = fs.readFileSync(EVAL_DATASET_PATH, "utf-8")
        const dataset = JSON.parse(fileContent)
        firstItemModel = dataset[0]?.llmModel || "Unknown"
      } catch (error) {
        Logger.warn("Could not load dataset to get model info for summary")
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const datasetName = path.basename(EVAL_DATASET_PATH, ".json")
      const modelNameForFilename = firstItemModel.replace(/:/g, ".")
      const summaryFilename = path.join(
        OUTPUT_DIR,
        `summary_${datasetName}_${modelNameForFilename}_alpha${defaultAlpha}_${timestamp}.txt`,
      )
      // Analysis results are not available here unless we collect them somehow
      const summaryContent = generateSummaryReport(
        metrics,
        metrics.rankDistribution.not_found > 0
          ? Object.values(metrics.rankDistribution).reduce((a, b) => a + b)
          : 0,
        0,
        [],
        EVAL_DATASET_PATH,
        firstItemModel, // Pass the model from dataset
      )
      try {
        fs.writeFileSync(summaryFilename, summaryContent)
        Logger.info(
          `Summary report for alpha=${defaultAlpha} saved to ${summaryFilename}`,
        )
        Logger.info("--- Summary Report (Evaluate Mode) --- ")
        summaryContent.split("\n").forEach((line) => Logger.info(line.trim()))
      } catch (error) {
        Logger.error(
          { error },
          "Failed to save summary report file for evaluate mode.",
        )
      }
    } else {
      Logger.error("Evaluation run failed, no metrics generated.")
    }
  } else if (EVAL_MODE === "optimize") {
    // Added Optimize Mode
    if (!EVAL_DATASET_PATH) {
      Logger.error(
        "Error: EVAL_MODE is 'optimize' but EVAL_DATASET_PATH environment variable is not set.",
      )
      Logger.error(
        "Please set EVAL_DATASET_PATH to the path of the .json dataset file.",
      )
      process.exit(1)
    }
    await optimizeAlpha(EVAL_DATASET_PATH)
  } else {
    Logger.error(`Error: Invalid or missing EVAL_MODE environment variable.`)
    Logger.error(
      `Please set EVAL_MODE to 'generate', 'evaluate', or 'optimize'.`,
    ) // Updated help text
    if (EVAL_MODE) {
      Logger.error(`Current value: ${EVAL_MODE}`)
    }
    process.exit(1)
  }
}

// --- Script Entry Point ---
mainEvaluationRouter().catch((error) => {
  Logger.error(
    { error: error?.message },
    "Unhandled error during main evaluation runner",
  )
  process.exit(1)
})
