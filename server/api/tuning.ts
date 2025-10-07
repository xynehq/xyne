import { type Context, Hono } from "hono"
import { type Variables } from "../server" // Import the Variables type
// import { type JwtPayload } from "hono/jwt"; // Removed direct import of JwtPayload
import type { ServerWebSocket } from "bun" // Added import
import type { WSContext, WSEvents } from "hono/ws" // Added import and WSEvents
import { createBunWebSocket } from "hono/bun" // Import for Bun WebSocket
// import { upgradeWebSocket } from 'hono/ws' // Removed incorrect import
// import { evaluateSearchQualityLLM } from "../scripts/evaluateSearchQualityLLM"; // Assuming this script exists and can be imported/adapted
// import { tuningWsConnections } from "../tuning/ws"; // Import tuningWsConnections <-- REMOVED THIS LINE
import * as fs from "fs/promises" // Import promises version of fs
import * as path from "path" // Import path module
import { z } from "zod" // Import z
import { zValidator } from "@hono/zod-validator" // Import zValidator
import { getLogger, getLoggerWithChild } from "@/logger" // Import logger
import { Subsystem } from "@/types" // Import Subsystem type
import config from "@/config" // Import config
import { getProviderByModel } from "@/ai/provider" // Restore provider getter
import type { LLMProvider, Models } from "@/ai/types" // Import AI types
import { searchVespa, GetRandomDocument } from "@/search/vespa" // Import Vespa functions
import { getSortedScoredChunks } from "@xyne/vespa-ts/mappers" // Import sorter
import pLimit from "p-limit" // Import p-limit
import type { Message } from "@aws-sdk/client-bedrock-runtime" // Required for provider interface
import {
  fileSchema,
  mailSchema,
  userSchema,
  eventSchema,
  mailAttachmentSchema,
} from "@xyne/vespa-ts/types" // Import schema names/types
import { upsertUserPersonalization } from "@/db/personalization" // Import personalization upsert
import { db } from "@/db/client" // Import db client
import { getUserByEmail } from "@/db/user" // Import user getter
import { getErrorMessage } from "@/utils" // Added import for getErrorMessage
import {
  getUserPersonalization,
  getUserPersonalizationByEmail,
} from "@/db/personalization" // Import personalization getters
import type { SelectPersonalization } from "@/db/schema" // Import personalization type
import { Ollama } from "ollama" // Import the base Ollama client library
import { OllamaProvider } from "@/ai/provider/ollama" // Import our specific provider wrapper
import { SearchModes } from "@xyne/vespa-ts/types" // Import SearchModes enum
// --- Define and Export WS Connections Map --- (Defined ONCE)
export const tuningWsConnections = new Map<
  string,
  WSContext<ServerWebSocket<any>>
>()

const { JwtPayloadKey } = config

const Logger = getLogger(Subsystem.Tuning)
const loggerWithChild = getLoggerWithChild(Subsystem.Tuning)
const { upgradeWebSocket } = createBunWebSocket<ServerWebSocket<undefined>>()

const EVAL_DATASETS_BASE_DIR = path.join(
  __dirname,
  "..",
  "tuning-data",
  "eval-datasets",
)

// --- Constants adapted from script ---
const NUM_SAMPLES_API = parseInt(
  process.env.API_TUNING_NUM_SAMPLES || "100",
  10,
) // Default to 100
const QUERIES_PER_DOC_API = parseInt(
  process.env.API_TUNING_QUERIES_PER_DOC || "1",
  10,
) // Smaller default for API
const MAX_FETCH_RETRIES_PER_SAMPLE_API = 3 // Limit retries for API context
const MAX_LLM_RETRIES_PER_DOC_API = 2
const MAX_VERIFICATION_RETRIES_API = 2
const GENERATE_CONCURRENCY_API = parseInt(
  process.env.API_TUNING_CONCURRENCY || "3",
  10,
)
const DELAY_MS_API = parseInt(process.env.API_TUNING_DELAY_MS || "50", 10)
const TUNING_OLLAMA_MODEL_NAME = process.env.TUNING_LLM_MODEL || "llama3:8b" // Tuning model name (string), default llama3:8b
const VESPA_NAMESPACE_API = "namespace" // TODO: Replace with actual Vespa namespace from config/env if possible
const VESPA_CLUSTER_NAME_API = "my_content" // TODO: Replace with actual cluster name

// --- Types adapted from script ---
interface VespaFields extends Record<string, any> {
  sddocname?: string
}

interface Document {
  id: string // User-facing ID
  vespaId: string // Full Vespa document ID
  fields: VespaFields
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

interface LLMVerificationResult {
  assessment:
    | "GOOD_QUERIES"
    | "BAD_QUERIES_IRRELEVANT"
    | "BAD_QUERIES_GENERIC"
    | "BAD_QUERIES_OBSCURE"
    | "ERROR"
  reasoning: string
}

// Added: Metrics type
interface Metrics {
  mrr: number
  ndcgAt10: number
  successAt1: number
  successAt3: number
  successAt5: number
  successAt10: number
  successRate: number // Success within MAX_RANK_TO_CHECK_API
  rankDistribution: Record<string, number>
}

// Added: EvaluationResult type for storing rank per query
interface EvaluationResult {
  docId: string
  vespaId: string
  query: string
  rank: number | null
}

// Mapping from sddocname to relevant fields (copied from script)
const schemaFieldMap: Record<
  string,
  {
    idField: string
    titleField: string
    bodyField?: string
    metadataFields?: string[]
  }
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
    metadataFields: ["fileType", "timestamp", "partId"],
  },
}

// --- Constants related to evaluation ---
const MAX_RANK_TO_CHECK_API = parseInt(
  process.env.API_TUNING_MAX_RANK || "50",
  10,
) // Limit rank checking for API
const HITS_PER_PAGE_API = 10

// --- End Constants and Types ---

// Zod schema for tuneDataset endpoint (Ensure Exported)
export const tuneDatasetSchema = z.object({ datasetFilename: z.string() })

// Zod schema for evaluate endpoint (UPDATED)
export const evaluateSchema = z.object({
  numSamples: z.number().int().positive().optional(),
  // numQueriesPerDoc: z.number().int().positive().optional(), // Keep this if needed later
  // Add other controllable parameters here in the future
})

// --- Helper Functions Adapted from Script ---

// Fetch random document from Vespa (adapted for API context)
async function getRandomDocumentApi(
  userEmail: string,
): Promise<Document | null> {
  const schemas = Object.keys(schemaFieldMap)
  const targetSchema = schemas[Math.floor(Math.random() * schemas.length)]
  loggerWithChild({ email: userEmail }).debug(
    `Fetching random document from schema: ${targetSchema}...`,
  )

  try {
    // Assuming GetRandomDocument is globally available or correctly imported
    const doc = await GetRandomDocument(
      VESPA_NAMESPACE_API,
      targetSchema,
      VESPA_CLUSTER_NAME_API,
    )

    if (!doc || !doc.id || !doc.fields) {
      loggerWithChild({ email: userEmail }).warn(
        { responseData: doc, schema: targetSchema },
        "Received invalid data structure from GetRandomDocument",
      )
      return null
    }

    const vespaId = doc.id
    const idParts = vespaId.split("::")
    const sddocname = doc.id.split(":")[2] || targetSchema
    const fieldMapping = schemaFieldMap[sddocname]

    if (!fieldMapping) {
      loggerWithChild({ email: userEmail }).warn(
        { vespaId, inferredSchema: sddocname },
        "Cannot process document: Schema not found in schemaFieldMap",
      )
      return null
    }

    const idField = fieldMapping.idField
    const titleField = fieldMapping.titleField
    const docIdFromFields = doc.fields[idField]
    const titleFromFields = doc.fields[titleField]
    const userFacingId = String(docIdFromFields) || idParts[1] || vespaId // Prefer field ID

    if (
      docIdFromFields === undefined ||
      docIdFromFields === null ||
      typeof titleFromFields !== "string" ||
      titleFromFields.trim() === ""
    ) {
      loggerWithChild({ email: userEmail }).warn(
        {
          vespaId,
          sddocname,
          idField,
          titleField,
          docIdValue: docIdFromFields,
          titleValue: titleFromFields,
        },
        `Document missing required ID or Title field, or title is empty. Skipping.`,
      )
      return null
    }

    return {
      id: userFacingId,
      vespaId: vespaId,
      fields: { ...(doc.fields as VespaFields), sddocname },
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      {
        error: error instanceof Error ? error.message : String(error),
        schema: targetSchema,
      },
      "Failed to get random document",
    )
    return null
  }
}

// Generate search queries using Ollama Provider (adapted for API context)
async function generateSearchQueriesApi(
  doc: Document,
  llmProvider: OllamaProvider, // Accept OllamaProvider instance
  userEmail: string,
): Promise<{
  queries: string[]
  sourceDocContext?: EvaluationDatasetItem["sourceDocContext"] | null
}> {
  const fields = doc.fields as VespaFields
  const sddocname = fields.sddocname

  if (!sddocname || !schemaFieldMap[sddocname]) {
    loggerWithChild({ email: userEmail }).warn(
      { docId: doc.id, sddocname },
      "Cannot generate query: Unknown schema",
    )
    return { queries: [], sourceDocContext: null }
  }

  const { titleField, metadataFields } = schemaFieldMap[sddocname]
  const title = fields[titleField] as string | undefined

  if (!title || title.trim() === "") {
    loggerWithChild({ email: userEmail }).warn(
      { docId: doc.id, sddocname, titleField },
      `Cannot generate query: Missing or empty title field ('${titleField}')`,
    )
    return { queries: [], sourceDocContext: null }
  }

  const metadataSnippet: Record<string, any> = {}
  if (metadataFields) {
    metadataFields.forEach((key) => {
      if (fields[key] !== undefined && fields[key] !== null) {
        // Basic cleanup for long metadata
        if (Array.isArray(fields[key]) && fields[key].length > 5)
          metadataSnippet[key] = fields[key].slice(0, 5).join(", ") + "..."
        else if (Array.isArray(fields[key]))
          metadataSnippet[key] = fields[key].join(", ")
        else metadataSnippet[key] = fields[key]
      }
    })
  }

  let chunks_summary: string[] = []
  if (fields.matchfeatures && Array.isArray(fields.chunks_summary)) {
    chunks_summary = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary,
    ).map((c) => c.chunk)
  } else if (Array.isArray(fields.chunks)) {
    chunks_summary = fields.chunks
  } else if (sddocname == "event" && fields.description) {
    chunks_summary = [fields.description]
  } else if (sddocname == "user" && fields.name && fields.email) {
    chunks_summary = [fields.name + " " + fields.email]
  }

  const chunksForPrompt = chunks_summary.slice(0, 5) // Use fewer chunks for API prompt

  if (!chunks_summary.length && sddocname !== "user" && sddocname !== "event") {
    // Allow user/event docs without chunks
    loggerWithChild({ email: userEmail }).warn(
      { docId: doc.id, sddocname },
      "No usable content/chunks found for query generation. Skipping.",
    )
    return { queries: [], sourceDocContext: null }
  }

  const systemPrompt = `Generate ${QUERIES_PER_DOC_API} diverse, realistic search queries a user might type to find the document described below. Focus ONLY on the provided context.`
  const sourceDocContextForPrompt = {
    title: title,
    body: chunksForPrompt.length > 0 ? chunksForPrompt : undefined,
  }
  const userPrompt = `**Instructions:**
Generate ${QUERIES_PER_DOC_API} realistic search queries for the document in the Context.
1. Focus: Keywords, concepts, or questions from the document's title or body.
2. Realism: Resemble common searches (3-7 words).
3. Context: Use ONLY the provided \`Document Context\`. Do NOT invent details.
4. Format: Output ONLY a valid JSON array string containing exactly ${QUERIES_PER_DOC_API} query strings. Example: ["query one", "query two"]

**Document Context:**
\`\`\`json
${JSON.stringify(sourceDocContextForPrompt, null, 2)}
\`\`\`

/no_think
`

  const messages: Message[] = [
    { role: "user", content: [{ text: userPrompt }] },
  ]
  const model = TUNING_OLLAMA_MODEL_NAME // Use the tuning model name string

  try {
    const response = await llmProvider.converse(messages, {
      modelId: model as Models,
      systemPrompt,
      temperature: 0.7,
      stream: false,
    })

    if (!response || !response.text || response.text.trim() === "") {
      loggerWithChild({ email: userEmail }).warn(
        { docId: doc.id },
        "Received empty response from LLM for query generation.",
      )
      return { queries: [], sourceDocContext: null }
    }

    let generatedQueries: string[] = []
    try {
      let cleanedResponseText = response.text
        .trim()
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/, "")
      const startIndex = cleanedResponseText.indexOf("[")
      const endIndex = cleanedResponseText.lastIndexOf("]")
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex)
        throw new Error("No JSON array found.")
      const jsonString = cleanedResponseText.substring(startIndex, endIndex + 1)
      const parsedJson = JSON.parse(jsonString)

      if (
        !Array.isArray(parsedJson) ||
        !parsedJson.every((item) => typeof item === "string")
      ) {
        throw new Error(
          `LLM response was not a JSON array of strings. Got: ${typeof parsedJson}`,
        )
      }
      generatedQueries = parsedJson.filter((q) => q.trim().length > 0)

      if (generatedQueries.length === 0) {
        loggerWithChild({ email: userEmail }).warn(
          { docId: doc.id, rawResponse: response.text },
          "LLM generated no valid query strings.",
        )
        return { queries: [], sourceDocContext: null }
      }
      if (generatedQueries.length !== QUERIES_PER_DOC_API) {
        loggerWithChild({ email: userEmail }).warn(
          {
            docId: doc.id,
            expected: QUERIES_PER_DOC_API,
            generated: generatedQueries.length,
          },
          `LLM generated ${generatedQueries.length} queries instead of ${QUERIES_PER_DOC_API}. Using generated count.`,
        )
      }
    } catch (parseError: any) {
      loggerWithChild({ email: userEmail }).error(
        {
          docId: doc.id,
          error: parseError.message,
          rawResponse: response.text,
        },
        "Failed to parse LLM query generation response",
      )
      return { queries: [], sourceDocContext: null }
    }

    const sourceDocContext: EvaluationDatasetItem["sourceDocContext"] = {
      docId: doc.id,
      vespaId: doc.vespaId,
      schema: sddocname,
      title: title,
      metadataSnippet,
      topNChunks: chunks_summary.length > 0 ? chunks_summary : undefined,
    }
    return { queries: generatedQueries, sourceDocContext }
  } catch (error: any) {
    loggerWithChild({ email: userEmail }).error(
      { docId: doc.id, model, error: error.message || String(error) },
      "Failed to generate queries using LLM",
    )
    return { queries: [], sourceDocContext: null }
  }
}

// Verify generated queries using LLM (adapted for API context)
async function verifyGeneratedQueriesApi(
  sourceDocContext: EvaluationDatasetItem["sourceDocContext"],
  generatedQueries: string[],
  llmProvider: OllamaProvider, // Accept OllamaProvider instance
  userEmail: string,
): Promise<LLMVerificationResult> {
  const { title, schema, topNChunks } = sourceDocContext
  const queriesString = generatedQueries.map((q) => `"${q}"`).join(", ")
  loggerWithChild({ email: userEmail }).debug(
    { docId: sourceDocContext.docId, queries: generatedQueries },
    "Verifying generated queries...",
  )

  const sourceContextString = `Source Document:\n- Title: "${title}"\n- Schema: ${schema}\n${
    topNChunks
      ? `- Chunks:\n${topNChunks
          .slice(0, 3)
          .map((c, i) => `  - ${c.substring(0, 100)}...`)
          .join("\n")}`
      : "- No chunks"
  }`
  const systemPrompt = `You are a search quality analyst. Evaluate if the generated search queries are relevant and plausible user searches for the given source document.`
  const userPrompt = `Evaluate the queries below for finding the source document:\n\n${sourceContextString}\n\nGenerated Queries:\n[${queriesString}]\n\nTask:\n1. Assess Relevance & Specificity.\n2. Choose ONE category: GOOD_QUERIES, BAD_QUERIES_IRRELEVANT, BAD_QUERIES_GENERIC, BAD_QUERIES_OBSCURE.\n3. Provide brief reasoning.\n\nOutput Format:\nReturn *only* a valid JSON object like {"assessment": "CATEGORY", "reasoning": "Brief reason."}`

  let lastError: Error | null = null
  const model = TUNING_OLLAMA_MODEL_NAME // Use the tuning model name string
  for (let attempt = 1; attempt <= MAX_VERIFICATION_RETRIES_API; attempt++) {
    try {
      const response = await llmProvider.converse(
        [{ role: "user", content: [{ text: userPrompt }] }],
        {
          modelId: model as Models,
          systemPrompt,
          temperature: 0.3,
          stream: false,
        },
      )

      if (!response || !response.text) throw new Error("LLM response empty.")
      let cleanedResponseText = response.text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim()
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/g, "")
        .trim()
      const jsonMatch = cleanedResponseText.match(/(\{.*?\})/s)
      if (!jsonMatch || !jsonMatch[0])
        throw new Error("No JSON object found in LLM response.")
      const parsedJson = JSON.parse(jsonMatch[0])

      if (
        typeof parsedJson.assessment !== "string" ||
        typeof parsedJson.reasoning !== "string"
      )
        throw new Error("Parsed JSON structure invalid.")

      loggerWithChild({ email: userEmail }).debug(
        { docId: sourceDocContext.docId, assessment: parsedJson.assessment },
        "LLM verification successful.",
      )
      return parsedJson as LLMVerificationResult
    } catch (error: any) {
      lastError = error
      loggerWithChild({ email: userEmail }).warn(
        { docId: sourceDocContext.docId, attempt, error: error?.message },
        `LLM verification attempt ${attempt} failed. Retrying...`,
      )
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_MS_API * attempt),
      )
    }
  }
  loggerWithChild({ email: userEmail }).error(
    { docId: sourceDocContext.docId, error: lastError?.message },
    `LLM verification failed after ${MAX_VERIFICATION_RETRIES_API} attempts.`,
  )
  return {
    assessment: "ERROR",
    reasoning: `Failed after ${MAX_VERIFICATION_RETRIES_API} attempts: ${lastError?.message || "Unknown error"}`,
  }
}

// Process a single sample (fetch -> generate -> verify) (adapted for API context)
async function processSingleSampleApi(
  sampleIndex: number,
  totalSamples: number,
  queryGenProvider: OllamaProvider, // Accept OllamaProvider instance
  sendProgress: (message: string) => void, // Keep signature, but we won't call it
  userEmail: string,
): Promise<EvaluationDatasetItem | null> {
  loggerWithChild({ email: userEmail }).debug(
    `--- Starting Sample ${sampleIndex + 1}/${totalSamples} ---`,
  )
  // sendProgress(`Fetching document ${sampleIndex + 1}/${totalSamples}...`) // Suppressed

  let doc: Document | null = null
  for (
    let fetchAttempt = 1;
    fetchAttempt <= MAX_FETCH_RETRIES_PER_SAMPLE_API;
    fetchAttempt++
  ) {
    doc = await getRandomDocumentApi(userEmail)
    if (doc) {
      loggerWithChild({ email: userEmail }).debug(
        `[Sample ${sampleIndex + 1}] Found candidate document (ID: ${doc.id})`,
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS_API))
  }
  if (!doc) {
    loggerWithChild({ email: userEmail }).warn(
      `[Sample ${sampleIndex + 1}] Failed to fetch document. Skipping sample.`,
    )
    // sendProgress(`Failed to fetch document ${sampleIndex + 1}. Skipping.`) // Suppressed
    return null
  }

  // sendProgress(
  //   `Generating queries for document ${sampleIndex + 1} (ID: ${doc.id.substring(0, 15)}...)...`,
  // ) // Suppressed
  let generatedResult: {
    queries: string[]
    sourceDocContext?: EvaluationDatasetItem["sourceDocContext"] | null
  } = { queries: [], sourceDocContext: null }
  for (
    let genAttempt = 1;
    genAttempt <= MAX_LLM_RETRIES_PER_DOC_API;
    genAttempt++
  ) {
    generatedResult = await generateSearchQueriesApi(
      doc,
      queryGenProvider,
      userEmail,
    ) // Pass provider
    if (generatedResult.queries.length > 0 && generatedResult.sourceDocContext)
      break // Allow fewer than requested
    loggerWithChild({ email: userEmail }).warn(
      `[Sample ${sampleIndex + 1}] Query Gen Attempt ${genAttempt} failed for Doc ID ${doc.id}. Retrying...`,
    )
    await new Promise((resolve) =>
      setTimeout(resolve, DELAY_MS_API * genAttempt),
    )
  }
  if (
    !generatedResult.sourceDocContext ||
    generatedResult.queries.length === 0
  ) {
    loggerWithChild({ email: userEmail }).warn(
      `[Sample ${sampleIndex + 1}] Failed to generate queries for Doc ID ${doc.id}. Skipping sample.`,
    )
    // sendProgress(
    //   `Failed to generate queries for document ${sampleIndex + 1}. Skipping.`,
    // ) // Suppressed
    return null
  }

  // sendProgress(`Verifying queries for document ${sampleIndex + 1}...`) // Suppressed
  const verificationResult = await verifyGeneratedQueriesApi(
    generatedResult.sourceDocContext,
    generatedResult.queries,
    queryGenProvider,
    userEmail,
  )
  if (verificationResult.assessment !== "GOOD_QUERIES") {
    loggerWithChild({ email: userEmail }).warn(
      { docId: doc.id, assessment: verificationResult.assessment },
      `[Sample ${sampleIndex + 1}] Queries failed verification. Skipping sample.`,
    )
    // sendProgress(
    //   `Generated queries for document ${sampleIndex + 1} failed verification. Skipping.`,
    // ) // Suppressed
    return null
  }

  loggerWithChild({ email: userEmail }).info(
    `[Sample ${sampleIndex + 1}] Generated queries VERIFIED as GOOD for Doc ID ${doc.id}.`,
  )
  // sendProgress(`Verified queries for document ${sampleIndex + 1}.`) // Suppressed

  const verifiedItem: EvaluationDatasetItem = {
    docId: doc.id,
    vespaId: doc.vespaId,
    schema: generatedResult.sourceDocContext.schema,
    title: generatedResult.sourceDocContext.title,
    llmModel: TUNING_OLLAMA_MODEL_NAME, // Record the tuning model name string
    queries: generatedResult.queries,
    sourceDocContext: generatedResult.sourceDocContext,
  }
  return verifiedItem
}

// --- End Helper Functions ---

// Placeholder function to simulate dataset generation (REPLACE THIS)
const generateDataset_OLD = async (
  userEmail: string,
  jobId: string,
): Promise<any> => {
  loggerWithChild({ email: userEmail }).info(
    `Generating dataset for job ${jobId} and user ${userEmail}...`,
  )
  // Simulate dataset generation
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const dummyDataset = {
    user: userEmail,
    jobId: jobId,
    data: [{ query: "test", results: ["doc1", "doc2"] }],
  }
  loggerWithChild({ email: userEmail }).info(
    `Dataset generated for job ${jobId}.`,
  )
  return dummyDataset
}

// --- NEW generateDataset function using adapted logic ---
async function generateDataset(
  userEmail: string,
  jobId: string,
  sendProgress: (message: string) => void,
  numSamplesParam?: number, // Added optional parameter
): Promise<EvaluationDatasetItem[]> {
  const numSamplesToGenerate = numSamplesParam ?? NUM_SAMPLES_API // Use param or default
  loggerWithChild({ email: userEmail }).info(
    `Starting real dataset generation for job ${jobId}, user ${userEmail}. Samples requested: ${numSamplesToGenerate} (Param: ${numSamplesParam}, Default: ${NUM_SAMPLES_API}). Tuning Model: ${TUNING_OLLAMA_MODEL_NAME}`,
  )
  // Initial progress message
  sendProgress(
    JSON.stringify({
      status: "generating",
      message: `Initializing dataset generation...`,
      completed: 0,
      total: numSamplesToGenerate,
      progress: 0,
    }),
  )

  // --- Instantiate independent Ollama provider ---
  if (!TUNING_OLLAMA_MODEL_NAME) {
    loggerWithChild({ email: userEmail }).error(
      "Error: Tuning Ollama model name is not configured (TUNING_LLM_MODEL env var needed).",
    )
    sendProgress("Error: LLM Model not configured.")
    throw new Error("Tuning LLM Model not configured.")
  }

  let queryGenProvider: OllamaProvider
  try {
    // Instantiate base Ollama client (assumes default host/port)
    const ollamaClient = new Ollama()
    // Instantiate our provider wrapper with the base client
    queryGenProvider = new OllamaProvider(ollamaClient)
    loggerWithChild({ email: userEmail }).info(
      { model: TUNING_OLLAMA_MODEL_NAME },
      "Instantiated independent OllamaProvider for tuning.",
    )
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      "Failed to instantiate independent OllamaProvider for tuning.",
      { model: TUNING_OLLAMA_MODEL_NAME },
    )
    sendProgress("Error: Could not initialize LLM provider.")
    throw new Error("Could not initialize LLM provider.")
  }
  // --- End independent instantiation ---

  const limit = pLimit(GENERATE_CONCURRENCY_API)
  const tasks: Promise<EvaluationDatasetItem | null>[] = []
  let completedCount = 0
  let failedCount = 0

  // --- Throttled Progress Reporting ---
  let progressInterval: Timer | null = null
  const reportInterval = 3000 // Send progress every 3 seconds

  const reportProgress = () => {
    const progress = Math.round((completedCount * 100) / numSamplesToGenerate)
    sendProgress(
      JSON.stringify({
        status: "generating",
        message: `Processed ${completedCount}/${numSamplesToGenerate} samples... (${failedCount} failed)`,
        completed: completedCount,
        total: numSamplesToGenerate,
        progress: progress,
      }),
    )
  }

  progressInterval = setInterval(reportProgress, reportInterval)
  // -----------------------------------

  for (let i = 0; i < numSamplesToGenerate; i++) {
    // Use determined number of samples
    tasks.push(
      limit(() =>
        processSingleSampleApi(
          i,
          numSamplesToGenerate, // Pass correct total
          queryGenProvider,
          (msg) => {}, // Suppress individual sample progress messages from processSingleSampleApi
          userEmail,
        )
          .then((result) => {
            if (result) {
              completedCount++
            } else {
              failedCount++
            }
            return result
          })
          .catch((err) => {
            // Also count errors from processSingleSampleApi itself as failed
            failedCount++
            loggerWithChild({ email: userEmail }).error(
              err,
              `Error in processSingleSampleApi for sample ${i + 1}`,
            )
            return null // Ensure promise resolves
          }),
      ),
    )
  }

  const results = await Promise.allSettled(tasks)

  // --- Stop Progress Reporting ---
  if (progressInterval) {
    clearInterval(progressInterval)
    progressInterval = null
    // Send final progress update immediately
    reportProgress()
  }
  // -------------------------------

  const dataset: EvaluationDatasetItem[] = []
  // We recalculate successCount from the final dataset length for accuracy
  let finalFailureCount = 0
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      dataset.push(result.value)
      // Logger.info( `[✓ Sample ${index + 1}/${numSamplesToGenerate}] OK for job ${jobId}` ); // Logging already happens inside processSingleSampleApi or is implied
    } else {
      finalFailureCount++ // Count final settlement failures
      const reason =
        result.status === "rejected"
          ? result.reason
          : "Processing failed or returned null"
      // Logger.error(`[✗ Sample ${index + 1}/${numSamplesToGenerate}] Failed during settlement for job ${jobId}: ${reason instanceof Error ? reason.message : String(reason)}`); // Covered by failedCount/error log inside task
    }
  })

  const finalSuccessCount = dataset.length

  loggerWithChild({ email: userEmail }).info(
    `Dataset generation finished for job ${jobId}. Success: ${finalSuccessCount}, Failed: ${finalFailureCount + failedCount} (Total Requested: ${numSamplesToGenerate})`,
  )
  // Final completion message (different from progress)
  sendProgress(
    JSON.stringify({
      status: "generated", // Use a distinct status
      message: `Dataset generation complete. ${finalSuccessCount} entries created.`,
      completed: finalSuccessCount,
      total: numSamplesToGenerate,
    }),
  )

  if (dataset.length === 0) {
    loggerWithChild({ email: userEmail }).error(
      `Job ${jobId}: No dataset entries could be generated successfully.`,
    )
    throw new Error("Failed to generate any valid dataset entries.")
  }

  return dataset
}
// --- End NEW generateDataset function ---

// Placeholder function to simulate alpha optimization (REPLACE THIS LATER)
const optimizeAlpha_OLD = async (
  dataset: any,
  userEmail: string,
  jobId: string,
  sendProgress: (message: string) => void,
): Promise<number> => {
  loggerWithChild({ email: userEmail }).info(
    `Optimizing alpha for job ${jobId} and user ${userEmail}...`,
  )
  sendProgress("Optimizing alpha (placeholder)...")
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const optimizedAlpha = Math.random()
  loggerWithChild({ email: userEmail }).info(
    `Alpha optimized: ${optimizedAlpha} for job ${jobId}.`,
  )
  sendProgress(
    `Alpha optimization complete (placeholder). Found alpha: ${optimizedAlpha.toFixed(4)}`,
  )
  return optimizedAlpha
}

// --- NEW optimizeAlpha function --- (Implementation Added)
async function optimizeAlpha(
  dataset: EvaluationDatasetItem[],
  userEmail: string,
  jobId: string,
  sendProgress: (message: string) => void,
): Promise<number> {
  const alphaValues = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] // Use 0.0-1.0 floats directly
  const evaluationResultsByAlpha: Record<number, EvaluationResult[]> = {}
  let bestAlpha = 0.5 // Default alpha (now 0.0-1.0)
  let bestMetrics: Metrics | null = null

  // --- Throttled Progress ---
  const queriesPerDataset = dataset.reduce(
    (sum, item) => sum + (item.queries?.length || 0),
    0,
  )
  const totalEvaluations = queriesPerDataset * alphaValues.length // Total evaluations across all alphas
  let overallCompletedEvaluations = 0 // Counter for overall evaluations
  let progressInterval: Timer | null = null
  const reportInterval = 3000 // 3 seconds

  const reportProgress = () => {
    if (totalEvaluations === 0) return // Avoid division by zero
    // Ensure progress doesn't exceed 100 due to potential async overlaps slightly after loop finishes
    const completed = Math.min(overallCompletedEvaluations, totalEvaluations)
    const progress = Math.round((completed * 100) / totalEvaluations)
    sendProgress(
      JSON.stringify({
        status: "optimizing",
        message: `Evaluating alpha values... (${completed}/${totalEvaluations} evaluations completed)`,
        completed: completed,
        total: totalEvaluations,
        progress: progress,
      }),
    )
  }
  // --- End Throttled Progress Setup ---

  sendProgress(
    JSON.stringify({
      status: "optimizing",
      message: `Starting alpha optimization (${totalEvaluations} total evaluations across ${alphaValues.length} alpha values)...`,
      completed: 0,
      total: totalEvaluations,
      progress: 0,
    }),
  )

  const limit = pLimit(GENERATE_CONCURRENCY_API)

  progressInterval = setInterval(reportProgress, reportInterval) // Start reporting

  for (const alpha of alphaValues) {
    // Log internally which alpha is being processed
    loggerWithChild({ email: userEmail }).debug(
      { jobId, alpha },
      `Starting evaluation for alpha ${alpha}`,
    )

    const tasks = dataset.flatMap((item) =>
      item.queries.map((query) =>
        limit(() =>
          findDocumentRankApi(
            item.sourceDocContext.docId,
            item.sourceDocContext.vespaId,
            query,
            alpha,
            userEmail,
          )
            .then((rank) => {
              overallCompletedEvaluations++ // Increment OVERALL count
              return {
                docId: item.sourceDocContext.docId,
                vespaId: item.sourceDocContext.vespaId,
                query,
                rank,
              }
            })
            .catch((err) => {
              overallCompletedEvaluations++ // Also count errors here so progress reaches 100%
              loggerWithChild({ email: userEmail }).error(
                err,
                `Error finding rank for query '${query}' during alpha optimization`,
              )
              return {
                docId: item.sourceDocContext.docId,
                vespaId: item.sourceDocContext.vespaId,
                query,
                rank: null, // Treat error as rank not found
              }
            }),
        ),
      ),
    )

    const resultsForAlpha: EvaluationResult[] = await Promise.all(tasks)
    evaluationResultsByAlpha[alpha] = resultsForAlpha

    const currentMetrics = calculateMetricsApi(
      resultsForAlpha,
      resultsForAlpha.length,
    ) // Renamed for clarity
    loggerWithChild({ email: userEmail }).info(
      {
        jobId,
        alpha: alpha,
        mrr: currentMetrics.mrr,
        ndcgAt10: currentMetrics.ndcgAt10,
      }, // Log float alpha
      `Evaluation complete for alpha`,
    )

    // --- Updated Best Alpha Logic (matches script) ---
    let isBetter = false
    if (!bestMetrics) {
      // First successful run
      isBetter = true
    } else {
      // Prioritize NDCG@10, then MRR
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
      bestMetrics = currentMetrics // Store the whole metrics object
      bestAlpha = alpha // Assign the float alpha directly
      loggerWithChild({ email: userEmail }).info(
        {
          jobId,
          bestAlpha: bestAlpha,
          bestMrr: bestMetrics.mrr,
          bestNdcg: bestMetrics.ndcgAt10,
        }, // Log float bestAlpha
        `New best alpha found`,
      )
    }
    // --- End Updated Logic ---

    await new Promise((resolve) => setTimeout(resolve, DELAY_MS_API)) // Avoid overwhelming Vespa
  }

  // --- Stop Progress Reporting & Send Final ---
  if (progressInterval) {
    clearInterval(progressInterval)
    progressInterval = null
    // Ensure final progress is 100% if all queries were processed
    overallCompletedEvaluations = totalEvaluations
    reportProgress()
  }

  sendProgress(
    JSON.stringify({
      status: "optimizing",
      message: `Optimization finished. Best alpha found: ${bestAlpha.toFixed(1)} (MRR: ${bestMetrics?.mrr.toFixed(4) ?? "N/A"}, NDCG@10: ${bestMetrics?.ndcgAt10.toFixed(4) ?? "N/A"})`,
      completed: overallCompletedEvaluations, // Send final counts
      total: totalEvaluations,
      progress: 100, // Assume 100% at the end
      result: {
        bestAlpha,
        bestMrr: bestMetrics?.mrr,
        bestNdcg: bestMetrics?.ndcgAt10,
      },
    }),
  )

  // --- Save the optimized alpha to the database ---
  try {
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new Error(`User not found: ${userEmail}`)
    }
    const user = users[0]
    const userId = user.id
    // Find workspaceId from the user record (assuming it exists there)
    // NOTE: This assumes getUserByEmail fetches workspaceId or you fetch the full user object
    // Alternatively, get workspaceId from the JWT payload if available earlier in the handler
    const workspaceId = user.workspaceId // Assuming user object has workspaceId
    if (!workspaceId) {
      throw new Error(`Could not determine workspaceId for user ${userEmail}`)
    }

    const personalizationData = {
      [SearchModes.NativeRank]: {
        alpha: bestAlpha, // Save the float alpha directly
      },
    } as SelectPersonalization["parameters"]
    await upsertUserPersonalization(
      db,
      userId,
      userEmail,
      workspaceId,
      personalizationData,
    )
    loggerWithChild({ email: userEmail }).info(
      {
        jobId,
        userId,
        userEmail,
        workspaceId,
        bestAlpha,
        profile: SearchModes.NativeRank,
      }, // Log float bestAlpha
      "Successfully saved optimized alpha to user personalization",
    )
    sendProgress(
      JSON.stringify({
        status: "saving",
        message: `Saved optimized alpha ${bestAlpha} for user ${userEmail}`,
      }),
    )
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      { error, jobId, userEmail, bestAlpha },
      `Failed to save optimized alpha to database: ${getErrorMessage(error)}`,
    )
    sendProgress(
      JSON.stringify({
        status: "error",
        message: `Failed to save optimized alpha: ${getErrorMessage(error)}`,
      }),
    )
    // Decide if this error should stop the whole process or just log
    // throw error; // Re-throw if saving is critical
  }
  // -------------------------------------------------

  return bestAlpha
}

// Interface for filename parameters
interface DatasetFilenameParams {
  s?: number // numSamples
  q?: number // numQueriesPerDoc (example for future)
  // Add other short keys here
}

// Helper to build the parameter string
function buildParamString(params: DatasetFilenameParams): string {
  const parts: string[] = []
  if (params.s !== undefined) parts.push(`s${params.s}`)
  if (params.q !== undefined) parts.push(`q${params.q}`)
  // Add other params here
  return parts.join("_")
}

// Helper to parse the parameter string from filename
function parseParamString(paramString: string): DatasetFilenameParams {
  const params: DatasetFilenameParams = {}
  const parts = paramString.split("_")
  parts.forEach((part) => {
    const key = part.charAt(0)
    const valueStr = part.substring(1)
    const valueNum = parseInt(valueStr, 10)
    if (!isNaN(valueNum)) {
      if (key === "s") params.s = valueNum
      else if (key === "q") params.q = valueNum
      // Add other keys here
    }
  })
  return params
}

// Modified evaluation job runner
const initAndRunEvaluationJob = async (
  jobId: string,
  userEmail: string,
  workspaceId: string,
  params: { numSamples?: number },
) => {
  const numSamplesToUse = params.numSamples ?? NUM_SAMPLES_API // Determine actual samples used (default 100)
  loggerWithChild({ email: userEmail }).info(
    `Evaluation job ${jobId} for user ${userEmail} in workspace ${workspaceId} started. Params: ${JSON.stringify(params)}, Samples Used: ${numSamplesToUse}`,
  )
  const ws = tuningWsConnections.get(jobId) // Initial get

  // Function to send progress updates via WebSocket
  const sendProgress = (message: string) => {
    const currentWs = tuningWsConnections.get(jobId) // Get latest WS reference
    if (currentWs) {
      currentWs.send(JSON.stringify({ event: "tuning:progress", message }))
    } else {
      loggerWithChild({ email: userEmail }).debug(
        `No tuning WebSocket connection found for job ID ${jobId} to send progress: ${message}`,
      )
    }
  }

  try {
    // 1. Generate dataset using the new real implementation
    const dataset = await generateDataset(
      userEmail,
      jobId,
      sendProgress,
      numSamplesToUse,
    ) // Pass the determined numSamples

    // Create user-specific directory if it doesn't exist
    const userDir = path.join(EVAL_DATASETS_BASE_DIR, userEmail)
    await fs.mkdir(userDir, { recursive: true })

    // --- Construct parameterized filename ---
    const filenameParams: DatasetFilenameParams = { s: numSamplesToUse }
    const paramString = buildParamString(filenameParams)
    const datasetFilename = `dataset-${jobId}-${paramString}.json`
    const datasetFilePath = path.join(userDir, datasetFilename)
    // --- End filename construction ---

    sendProgress(`Saving dataset (${dataset.length} entries) to file...`)
    await fs.writeFile(datasetFilePath, JSON.stringify(dataset, null, 2))
    sendProgress(`Dataset saved to ${datasetFilename}`)

    // 2. Optimize alpha
    const optimizedAlpha = await optimizeAlpha(
      dataset,
      userEmail,
      jobId,
      sendProgress,
    ) // Pass sendProgress

    // Signal completion
    const completionMessage = {
      event: "tuning:complete",
      message: `Optimization complete. Best alpha (placeholder): ${optimizedAlpha.toFixed(4)}`,
    }
    const finalWs = tuningWsConnections.get(jobId)
    if (finalWs) {
      finalWs.send(JSON.stringify(completionMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on completion.`,
      )
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error during evaluation job ${jobId} for user ${userEmail}`,
    )
    const errorMessage = {
      event: "tuning:error",
      error:
        error instanceof Error
          ? error.message
          : "Unknown error during evaluation job",
    }
    const errorWs = tuningWsConnections.get(jobId)
    if (errorWs) {
      errorWs.send(JSON.stringify(errorMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on error.`,
      )
    }
  }
}

// Function to run tuning with a specified dataset file
const runTuningWithDataset = async (
  jobId: string,
  userEmail: string,
  workspaceId: string,
  datasetFilePath: string,
) => {
  loggerWithChild({ email: userEmail }).info(
    `Tuning job ${jobId} for user ${userEmail} in workspace ${workspaceId} started using dataset ${datasetFilePath}.`,
  )
  const ws = tuningWsConnections.get(jobId) // Initial get

  const sendProgress = (message: string) => {
    const currentWs = tuningWsConnections.get(jobId)
    if (currentWs) {
      currentWs.send(JSON.stringify({ event: "tuning:progress", message }))
    } else {
      loggerWithChild({ email: userEmail }).debug(
        `No tuning WebSocket connection found for job ID ${jobId} to send progress: ${message}`,
      )
    }
  }

  try {
    // 1. Load dataset from file
    sendProgress("Loading dataset...")
    const datasetFileContent = await fs.readFile(datasetFilePath, "utf-8")
    const dataset = JSON.parse(datasetFileContent) // Assuming it's EvaluationDatasetItem[]
    if (!Array.isArray(dataset))
      throw new Error("Dataset file content is not an array.")
    sendProgress(`Dataset loaded (${dataset.length} entries).`)

    // 2. Optimize alpha (STILL USING PLACEHOLDER)
    const optimizedAlpha = await optimizeAlpha(
      dataset,
      userEmail,
      jobId,
      sendProgress,
    ) // Pass sendProgress

    // Signal completion
    const completionMessage = {
      event: "tuning:complete",
      message: `Optimization complete using ${path.basename(datasetFilePath)}. Best alpha (placeholder): ${optimizedAlpha.toFixed(4)}`,
    }
    const finalWs = tuningWsConnections.get(jobId)
    if (finalWs) {
      finalWs.send(JSON.stringify(completionMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on completion.`,
      )
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error during tuning job ${jobId} for user ${userEmail} with dataset ${datasetFilePath}`,
    )
    const errorMessage = {
      event: "tuning:error",
      error:
        error instanceof Error
          ? error.message
          : "Unknown error during tuning job",
    }
    const errorWs = tuningWsConnections.get(jobId)
    if (errorWs) {
      errorWs.send(JSON.stringify(errorMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on error.`,
      )
    }
  }
}

// --- Helper Functions Added/Adapted for Optimization ---

// Find the rank of a specific document for a given query and alpha (adapted from script)
async function findDocumentRankApi(
  docIdToFind: string, // User-facing ID
  vespaIdToFind: string, // Full Vespa ID
  query: string,
  alpha: number, // Alpha value for hybrid search
  userEmail: string, // User email for permission check
): Promise<number | null> {
  loggerWithChild({ email: userEmail }).debug(
    { docIdToFind, vespaIdToFind, query, alpha, userEmail },
    "findDocumentRankApi called",
  )

  let rank: number | null = null
  let offset = 0

  try {
    while (offset < MAX_RANK_TO_CHECK_API) {
      const searchOptions: Record<string, any> = {
        limit: HITS_PER_PAGE_API,
        offset: offset,
        rankProfile: SearchModes.NativeRank, // Or your custom hybrid rank profile name
        alpha: alpha, // Pass alpha correctly
      }

      const response = await searchVespa(
        query,
        userEmail,
        null,
        null,
        searchOptions,
      )

      const hits = response.root.children || []
      const totalCount = response.root.fields?.totalCount || 0

      if (hits.length === 0) break // No more hits

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]
        const currentRank = offset + i + 1
        const hitVespaId = hit.id

        if (hitVespaId && hitVespaId === vespaIdToFind) {
          rank = currentRank
          loggerWithChild({ email: userEmail }).trace(
            `---> Match found at rank ${rank}! Vespa ID: ${vespaIdToFind}, Query: ${query.substring(0, 30)}...`,
          )
          break // Exit inner loop
        }
      }

      if (rank !== null) break // Exit outer loop

      offset += HITS_PER_PAGE_API

      // Stop pagination checks (similar to script)
      if (
        totalCount > 0 &&
        offset >= totalCount &&
        totalCount <= MAX_RANK_TO_CHECK_API
      )
        break
      else if (
        offset >= MAX_RANK_TO_CHECK_API &&
        totalCount > MAX_RANK_TO_CHECK_API
      )
        break
      else if (totalCount === 0 && offset > 0) break
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      {
        error: error instanceof Error ? error.message : String(error),
        query,
        vespaIdToFind,
        alpha,
      },
      "Failed to search for document rank due to error",
    )
    return null // Return null rank on error
  }

  return rank
}

// Calculate evaluation metrics (adapted from script)
function calculateMetricsApi(
  results: EvaluationResult[],
  totalQueries: number,
): Metrics {
  const numResultsWithRank = results.filter((r) => r.rank !== null).length

  if (totalQueries === 0) {
    // Return zero metrics if no queries evaluated
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
        "11+ or Not Found": 0,
      },
    }
  }

  const rankDistribution: Record<string, number> = {
    "1": 0,
    "2-3": 0,
    "4-5": 0,
    "6-10": 0,
    "11+ or Not Found": 0,
  }
  let reciprocalRankSum = 0
  let ndcgAt10Sum = 0
  let successAt1Count = 0
  let successAt3Count = 0
  let successAt5Count = 0
  let successAt10Count = 0
  let successRateCount = 0

  results.forEach((result) => {
    const rank = result.rank
    if (rank !== null && rank <= MAX_RANK_TO_CHECK_API) {
      reciprocalRankSum += 1 / rank
      successRateCount++

      if (rank <= 10) {
        ndcgAt10Sum += 1 / Math.log2(rank + 1)
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

      // Simplified binning for API context
      if (rank === 1) rankDistribution["1"]++
      else if (rank <= 3) rankDistribution["2-3"]++
      else if (rank <= 5) rankDistribution["4-5"]++
      else if (rank <= 10) rankDistribution["6-10"]++
      else rankDistribution["11+ or Not Found"]++ // Group ranks > 10
    } else {
      rankDistribution["11+ or Not Found"]++ // Count ranks > MAX_RANK_TO_CHECK or null
    }
  })

  // Normalize NDCG@10: Ideal DCG for a single relevant item at rank 1 is 1/log2(1+1) = 1
  const idealDcgAt10 = 1.0
  const avgNdcgAt10 =
    numResultsWithRank > 0 ? ndcgAt10Sum / numResultsWithRank / idealDcgAt10 : 0

  return {
    mrr: numResultsWithRank > 0 ? reciprocalRankSum / numResultsWithRank : 0, // MRR calculated only over queries where rank was found
    ndcgAt10: avgNdcgAt10,
    successAt1: successAt1Count / totalQueries,
    successAt3: successAt3Count / totalQueries,
    successAt5: successAt5Count / totalQueries,
    successAt10: successAt10Count / totalQueries,
    successRate: successRateCount / totalQueries,
    rankDistribution,
  }
}

// --- End Optimization Helpers ---

// --- Route Handlers --- (NEW: Defined and Exported)

// POST /api/v1/tuning/evaluate
export const EvaluateHandler = async (c: Context<{ Variables: Variables }>) => {
  const jwtPayload = c.get("jwtPayload") as { sub: string; workspaceId: string }
  const userEmail = jwtPayload.sub
  const workspaceId = jwtPayload.workspaceId
  if (!userEmail) return c.json({ error: "User email not found in token" }, 401)
  if (!workspaceId)
    return c.json({ error: "Workspace ID not found in token" }, 401)

  // --- NEW: Validate request body ---
  let numSamples: number | undefined
  try {
    // Try to parse JSON, handle potential errors gracefully
    const body = await c.req.json().catch(() => null)
    if (body) {
      const validation = evaluateSchema.safeParse(body)
      if (!validation.success) {
        return c.json(
          { error: "Invalid request body", details: validation.error },
          400,
        )
      }
      numSamples = validation.data.numSamples
      loggerWithChild({ email: userEmail }).info(
        { userEmail, numSamples },
        "Received evaluate request with parameters",
      )
    } else {
      loggerWithChild({ email: userEmail }).info(
        { userEmail },
        "Received evaluate request with empty/invalid body, using defaults.",
      )
    }
  } catch (e) {
    // Catch any unexpected errors during parsing
    loggerWithChild({ email: userEmail }).error(
      e,
      "Error parsing evaluate request body, using defaults.",
      {
        userEmail,
      },
    )
  }
  // --- END NEW ---

  const jobId = `tuning-job-${Date.now()}`
  // --- Pass parameters to the job runner ---
  initAndRunEvaluationJob(jobId, userEmail, workspaceId, { numSamples })
  loggerWithChild({ email: userEmail }).info(
    `Started evaluation job ${jobId} for user ${userEmail} in workspace ${workspaceId}`,
  )
  return c.json({ jobId })
}

// GET /api/v1/tuning/datasets
export const ListDatasetsHandler = async (
  c: Context<{ Variables: Variables }>,
) => {
  const jwtPayload = c.get("jwtPayload") as { sub: string }
  const userEmail = jwtPayload.sub
  if (!userEmail) return c.json({ error: "User email not found in token" }, 401)

  const userDir = path.join(EVAL_DATASETS_BASE_DIR, userEmail)
  try {
    const files = await fs.readdir(userDir)
    // --- Regex to parse filename ---
    // Matches: dataset-ANYTHING-(PARAMSTRING).json
    // Groups: 1: jobId (anything after dataset-), 2: paramString (e.g., s100_q1)
    const datasetRegex = /^dataset-(.+)-([a-zA-Z0-9_]+)\.json$/

    const datasets = files
      .map((file) => {
        const match = file.match(datasetRegex)
        if (match) {
          const jobIdPart = match[1]
          const paramString = match[2]
          const parsedParams = parseParamString(paramString)
          return {
            filename: file,
            jobId: jobIdPart,
            params: parsedParams,
          }
        } else if (file.startsWith("dataset-") && file.endsWith(".json")) {
          // Handle older files or files not matching the pattern (LEGACY)
          const oldJobIdMatch = file.match(/^dataset-(.+)-s(\d+)\.json$/)
          if (oldJobIdMatch) {
            return {
              filename: file,
              jobId: oldJobIdMatch[1],
              params: { s: parseInt(oldJobIdMatch[2], 10) || undefined },
            }
          }
          // Fallback for very old files with no params
          return {
            filename: file,
            jobId: file.replace(/^dataset-|\.json$/g, ""),
            params: {},
          }
        }
        return null // Ignore files not matching dataset patterns
      })
      .filter(Boolean) // Remove null entries

    return c.json({ datasets })
  } catch (error: any) {
    if (error.code === "ENOENT") return c.json({ datasets: [] }) // No directory means no datasets
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error listing datasets for user ${userEmail}`,
    )
    return c.json({ error: "Failed to list datasets" }, 500)
  }
}

// POST /api/v1/tuning/tuneDataset
export const TuneDatasetHandler = async (
  c: Context<{ Variables: Variables }>,
) => {
  const jwtPayload = c.get("jwtPayload") as { sub: string; workspaceId: string }
  const userEmail = jwtPayload.sub
  const workspaceId = jwtPayload.workspaceId
  if (!userEmail) return c.json({ error: "User email not found in token" }, 401)
  if (!workspaceId)
    return c.json({ error: "Workspace ID not found in token" }, 401)

  // Assumes validation already happened via zValidator in server.ts
  const validatedData = await c.req.json()
  const datasetFilename = validatedData.datasetFilename as string
  const datasetFilePath = path.join(
    EVAL_DATASETS_BASE_DIR,
    userEmail,
    datasetFilename,
  )

  try {
    await fs.access(datasetFilePath)
  } catch (error: any) {
    if (error.code === "ENOENT")
      return c.json({ error: "Dataset file not found" }, 404)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Error accessing dataset file ${datasetFilePath} for user ${userEmail}`,
    )
    return c.json({ error: "Failed to access dataset file" }, 500)
  }

  const jobId = `tuning-dataset-job-${Date.now()}`
  runTuningWithDataset(jobId, userEmail, workspaceId, datasetFilePath)
  loggerWithChild({ email: userEmail }).info(
    `Started tuning job ${jobId} for user ${userEmail} in workspace ${workspaceId} with dataset ${datasetFilename}`,
  )
  return c.json({ jobId })
}

// --- New Function to Run Evaluation on a Specific Dataset ---
async function runEvaluationWithDataset(
  jobId: string,
  userEmail: string,
  workspaceId: number,
  datasetFilePath: string,
) {
  loggerWithChild({ email: userEmail }).info(
    `Evaluation job ${jobId} for user ${userEmail} (ws ${workspaceId}) started using dataset ${datasetFilePath}.`,
  )
  const ws = tuningWsConnections.get(jobId)

  const sendProgress = (message: string) => {
    const currentWs = tuningWsConnections.get(jobId)
    if (currentWs) {
      currentWs.send(JSON.stringify({ event: "tuning:progress", message }))
    } else {
      loggerWithChild({ email: userEmail }).debug(
        `No tuning WebSocket connection found for job ID ${jobId} to send progress: ${message}`,
      )
    }
  }

  try {
    // 1. Load dataset
    sendProgress(
      JSON.stringify({
        status: "loading",
        message: `Loading dataset ${path.basename(datasetFilePath)}...`,
      }),
    )
    const datasetFileContent = await fs.readFile(datasetFilePath, "utf-8")
    const dataset = JSON.parse(datasetFileContent) as EvaluationDatasetItem[]
    if (!Array.isArray(dataset) || dataset.length === 0) {
      throw new Error("Dataset file is empty or invalid.")
    }
    sendProgress(
      JSON.stringify({
        status: "loading",
        message: `Dataset loaded (${dataset.length} entries).`,
      }),
    )

    // 2. Get User's Alpha (or default)
    let alphaToUse = 0.5 // Default alpha
    try {
      const personalization = await getUserPersonalizationByEmail(db, userEmail) // Use new function
      if (personalization) {
        const nativeRankParams =
          personalization.parameters?.[SearchModes.NativeRank]
        if (nativeRankParams?.alpha !== undefined) {
          alphaToUse = nativeRankParams.alpha
          loggerWithChild({ email: userEmail }).info(
            { jobId, userEmail, alpha: alphaToUse },
            "Using stored alpha for evaluation.",
          ) // Log email
        } else {
          loggerWithChild({ email: userEmail }).info(
            { jobId, userEmail },
            "No stored alpha found, using default for evaluation.",
          ) // Log email
        }
      } else {
        loggerWithChild({ email: userEmail }).warn(
          { jobId, userEmail },
          "User personalization settings not found, using default alpha for evaluation.",
        ) // Log email
      }
    } catch (err) {
      // Use Logger.warn for non-critical failure to get personalization
      loggerWithChild({ email: userEmail }).warn(
        { error: err, jobId, userEmail }, // Correct warn signature
        `Failed to get user personalization, using default alpha ${alphaToUse}. Error: ${getErrorMessage(err)}`,
      )
    }
    sendProgress(
      JSON.stringify({
        status: "evaluating",
        message: `Evaluating dataset using alpha = ${alphaToUse.toFixed(2)}...`,
      }),
    )

    // 3. Evaluate queries
    const limit = pLimit(GENERATE_CONCURRENCY_API)
    const evaluationTasks: Promise<EvaluationResult | null>[] = []
    let totalQueries = 0

    dataset.forEach((item) => {
      if (item.queries && item.queries.length > 0) {
        item.queries.forEach((query) => {
          totalQueries++
          evaluationTasks.push(
            limit(async () => {
              try {
                const rank = await findDocumentRankApi(
                  item.sourceDocContext.docId,
                  item.sourceDocContext.vespaId,
                  query,
                  alphaToUse, // Use determined alpha
                  userEmail,
                )
                return {
                  docId: item.sourceDocContext.docId,
                  vespaId: item.sourceDocContext.vespaId,
                  schema: item.sourceDocContext.schema,
                  title: item.sourceDocContext.title,
                  rank: rank,
                  query: query,
                  llmModel: item.llmModel,
                }
              } catch (rankError) {
                loggerWithChild({ email: userEmail }).error(
                  rankError, // Error object first
                  "Error during findDocumentRankApi", // Then the message
                  {
                    // Metadata object last
                    jobId,
                    docId: item.sourceDocContext.docId,
                    query,
                    alpha: alphaToUse,
                  },
                )
                return null // Return null on error for this query
              }
            }),
          )
        })
      }
    })

    const settledResults = await Promise.allSettled(evaluationTasks)
    const finalResults: EvaluationResult[] = []
    settledResults.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        finalResults.push(result.value)
      }
      // Optionally log rejections
    })

    if (finalResults.length === 0) {
      throw new Error("No queries could be successfully evaluated.")
    }

    // 4. Calculate Metrics
    sendProgress(
      JSON.stringify({
        status: "calculating",
        message: `Calculating metrics based on ${finalResults.length} results...`,
      }),
    )
    const metrics = calculateMetricsApi(finalResults, totalQueries)
    loggerWithChild({ email: userEmail }).info(
      { jobId, metrics },
      "Dataset evaluation metrics calculated.",
    )

    // 5. Send Completion Message
    const completionMessage = {
      event: "tuning:evaluateComplete", // Use a distinct event name
      message: `Evaluation complete for ${path.basename(datasetFilePath)} using alpha ${alphaToUse.toFixed(2)}.`,
      metrics: metrics, // Send the metrics object
      jobId: jobId, // Include jobId for frontend matching
    }
    const finalWs = tuningWsConnections.get(jobId)
    if (finalWs) {
      finalWs.send(JSON.stringify(completionMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on completion.`,
      )
    }
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error, // Error object first
      `Error during dataset evaluation job ${jobId}`, // Message second
      {
        // Metadata third
        userEmail,
        workspaceId,
        datasetFilePath,
        errorMessage: getErrorMessage(error),
      },
    )
    sendProgress(
      JSON.stringify({
        status: "error",
        message: `Evaluation failed: ${getErrorMessage(error)}`,
      }),
    )
    const errorMessage = {
      event: "tuning:error",
      error:
        error instanceof Error
          ? error.message
          : "Unknown error during evaluation job",
      jobId: jobId,
    }
    const errorWs = tuningWsConnections.get(jobId)
    if (errorWs) {
      errorWs.send(JSON.stringify(errorMessage))
    } else {
      loggerWithChild({ email: userEmail }).warn(
        `No tuning WebSocket connection found for job ID ${jobId} on error.`,
      )
    }
  } finally {
    // Optional: Clean up WebSocket connection if it shouldn't persist
    // tuningWsConnections.delete(jobId);
  }
}
// --- End runEvaluationWithDataset ---

// --- New Handler for Evaluating a Specific Dataset ---
export const EvaluateDatasetHandler = async (
  c: Context<{ Variables: Variables }>,
) => {
  const jwtPayload = c.get("jwtPayload") as { sub: string; workspaceId: string }
  const userEmail = jwtPayload.sub
  const workspaceIdString = jwtPayload.workspaceId // Keep as string for logging if needed
  if (!userEmail) return c.json({ error: "User email not found in token" }, 401)
  if (!workspaceIdString)
    return c.json({ error: "Workspace ID not found in token" }, 401)

  // Get workspaceId as number (assuming it's stored as integer)
  let workspaceId: number | null = null
  try {
    const users = await getUserByEmail(db, userEmail)
    if (users && users.length > 0) {
      workspaceId = users[0].workspaceId // Assuming workspaceId is on user object
    } else {
      throw new Error("User not found in DB to confirm workspace ID")
    }
  } catch (err) {
    // Correct Logger.error call signature
    loggerWithChild({ email: userEmail }).error(
      err,
      `Failed to get user/workspace ID for evaluation.`,
      {
        userEmail,
      },
    )
    return c.json({ error: "Failed to verify user workspace" }, 403)
  }

  if (workspaceId === null) {
    return c.json({ error: "Could not resolve workspace ID" }, 400)
  }

  // Validate incoming JSON body for datasetFilename
  const body = await c.req.json().catch(() => null)
  const validation = z.object({ datasetFilename: z.string() }).safeParse(body)
  if (!validation.success || !body) {
    return c.json(
      { error: "Invalid request body", details: validation.error },
      400,
    )
  }

  const datasetFilename = validation.data.datasetFilename
  const datasetFilePath = path.join(
    EVAL_DATASETS_BASE_DIR,
    userEmail, // Ensure dataset is within the user's directory
    datasetFilename,
  )

  // Check file existence
  try {
    await fs.access(datasetFilePath)
  } catch (error: any) {
    if (error.code === "ENOENT") {
      loggerWithChild({ email: userEmail }).warn(
        { datasetFilePath, userEmail },
        "Dataset file not found for evaluation request",
      ) // Correct warn signature
      return c.json({ error: "Dataset file not found" }, 404)
    }
    loggerWithChild({ email: userEmail }).error(
      error, // Error first
      `Error accessing dataset file for user ${userEmail}`, // Message second
      { datasetFilePath }, // Metadata third
    )
    return c.json({ error: "Failed to access dataset file" }, 500)
  }

  const jobId = `eval-dataset-job-${Date.now()}`
  // Fire-and-forget the evaluation job
  runEvaluationWithDataset(jobId, userEmail, workspaceId, datasetFilePath)
  loggerWithChild({ email: userEmail }).info(
    `Started dataset evaluation job ${jobId} for user ${userEmail} with dataset ${datasetFilename}`,
  )
  return c.json({ jobId })
}
// --- End EvaluateDatasetHandler ---

// --- New Handler for Deleting a Specific Dataset ---
export const DeleteDatasetHandler = async (
  c: Context<{ Variables: Variables }>,
) => {
  const jwtPayload = c.get("jwtPayload") as { sub: string }
  const userEmail = jwtPayload.sub
  if (!userEmail) return c.json({ error: "User email not found in token" }, 401)

  const filename = c.req.param("filename")
  if (!filename) {
    return c.json({ error: "Filename parameter is missing" }, 400)
  }

  // Basic validation: ensure filename looks like a dataset file and doesn't try path traversal
  // A more robust validation might involve checking against the jobId pattern if needed.
  if (
    !filename.startsWith("dataset-") ||
    !filename.endsWith(".json") ||
    filename.includes("..") ||
    filename.includes("/")
  ) {
    loggerWithChild({ email: userEmail }).warn(
      { userEmail, filename },
      "Attempted to delete invalid or potentially malicious filename.",
    )
    return c.json({ error: "Invalid filename format" }, 400)
  }

  const userDir = path.join(EVAL_DATASETS_BASE_DIR, userEmail)
  const filePath = path.join(userDir, filename)

  // --- Security Check: Ensure the resolved path is within the user's directory ---
  const resolvedPath = path.resolve(filePath)
  const resolvedUserDir = path.resolve(userDir)
  if (!resolvedPath.startsWith(resolvedUserDir + path.sep)) {
    loggerWithChild({ email: userEmail }).error(
      { userEmail, filename, filePath, resolvedPath, resolvedUserDir },
      "Path traversal attempt detected during dataset deletion.",
    )
    return c.json({ error: "Invalid file path" }, 400)
  }
  // --- End Security Check ---

  try {
    await fs.unlink(filePath)
    loggerWithChild({ email: userEmail }).info(
      { userEmail, filename },
      "Successfully deleted dataset file.",
    )
    return c.json(
      { message: `Dataset '${filename}' deleted successfully.` },
      200,
    )
  } catch (error: any) {
    if (error.code === "ENOENT") {
      loggerWithChild({ email: userEmail }).warn(
        { userEmail, filename },
        "Attempted to delete non-existent dataset file.",
      )
      return c.json({ error: "Dataset file not found" }, 404)
    } else {
      loggerWithChild({ email: userEmail }).error(
        error,
        `Error deleting dataset file for user ${userEmail}`,
        {
          filename,
        },
      )
      return c.json({ error: "Failed to delete dataset file" }, 500)
    }
  }
}
// --- End DeleteDatasetHandler ---

// WebSocket upgrade callback function
const tuningWsCallback = (
  c: Context<{ Variables: Variables }>,
): WSEvents<ServerWebSocket<any>> => {
  const jobId = c.req.param("jobId")
  const jwtPayload = c.get("jwtPayload")
  const email = jwtPayload?.sub
  return {
    onOpen: (evt: Event, ws: WSContext<ServerWebSocket<any>>) => {
      if (!jobId) {
        loggerWithChild({ email: email }).error(
          "WebSocket opened without jobId!",
        )
        ws.close(1008, "Missing jobId")
        return
      }
      loggerWithChild({ email: email }).info(
        `WebSocket opened for tuning job: ${jobId}`,
      )
      tuningWsConnections.set(jobId, ws)
      ws.send(
        JSON.stringify({
          event: "tuning:connected",
          message: `WebSocket connected for job ${jobId}.`,
        }),
      )
    },
    onMessage: (evt: MessageEvent, ws: WSContext<ServerWebSocket<any>>) => {
      loggerWithChild({ email: email }).info(
        `Message from tuning client ${jobId}: ${evt.data}`,
      )
    },
    onClose: (evt: CloseEvent, ws: WSContext<ServerWebSocket<any>>) => {
      const closedJobId =
        Array.from(tuningWsConnections.entries()).find(
          ([key, value]) => value === ws,
        )?.[0] || jobId
      if (closedJobId) {
        loggerWithChild({ email: email }).info(
          `WebSocket closed for tuning job: ${closedJobId} (Code: ${evt.code}, Reason: ${evt.reason})`,
        )
        tuningWsConnections.delete(closedJobId)
      } else {
        loggerWithChild({ email: email }).warn(
          `WebSocket closed but could not determine jobId.`,
        )
      }
    },
    onError: (evt: Event, ws: WSContext<ServerWebSocket<any>>) => {
      const errorJobId =
        Array.from(tuningWsConnections.entries()).find(
          ([key, value]) => value === ws,
        )?.[0] || jobId
      if (errorJobId) {
        loggerWithChild({ email: email }).error(
          evt,
          `WebSocket error for tuning job ${errorJobId}`,
        )
        tuningWsConnections.delete(errorJobId)
      } else {
        loggerWithChild({ email: email }).error(
          evt,
          `WebSocket error but could not determine jobId.`,
        )
      }
    },
  }
}

// Export the configured WebSocket route handler for GET /api/v1/tuning/ws/:jobId
export const TuningWsRoute = upgradeWebSocket(tuningWsCallback)
