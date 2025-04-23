import { searchVespa, SearchModes, GetRandomDocument } from "@/search/vespa"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { VespaSearchResult } from "@/search/types"
import {
  fileSchema,
  mailSchema,
  userSchema,
  eventSchema,
  mailAttachmentSchema,
} from "@/search/types"
import fs from "fs"

// Configuration
const Logger = getLogger(Subsystem.Eval)

// Get email from environment variable
const USER_EMAIL_FOR_SEARCH = process.env.EVALUATION_USER_EMAIL

if (!USER_EMAIL_FOR_SEARCH) {
  Logger.error("Error: Environment variable EVALUATION_USER_EMAIL is not set.")
  Logger.error("This email is required for permission-aware search evaluation.")
  Logger.error(
    "Please set it and run the script again. Example: EVALUATION_USER_EMAIL='user@example.com' bun run ...",
  )
  process.exit(1)
}

Logger.info(`Using email for search evaluation: ${USER_EMAIL_FOR_SEARCH}`)

const NUM_SAMPLES = 100
const MAX_RANK_TO_CHECK = 100
const HITS_PER_PAGE = 10
const VESPA_NAMESPACE = "namespace" // TODO: Replace with your actual Vespa namespace
const VESPA_CLUSTER_NAME = "my_content" // TODO: Replace with your actual cluster name
const DELAY_MS = parseInt(process.env.EVALUATION_DELAY_MS || "5", 10)
const ENABLE_TRACE = false

// Mapping from sddocname to relevant fields
const schemaFieldMap: Record<string, { idField: string; titleField: string }> =
  {
    [fileSchema]: { idField: "docId", titleField: "title" },
    [mailSchema]: { idField: "docId", titleField: "subject" },
    [userSchema]: { idField: "docId", titleField: "name" },
    [eventSchema]: { idField: "docId", titleField: "name" },
    [mailAttachmentSchema]: { idField: "docId", titleField: "filename" },
  }

// Types
interface VespaFields extends Record<string, any> {
  sddocname?: string
}

interface Document {
  id: string
  fields: VespaFields
}

interface SampleResult {
  docId: string
  schema: string
  title: string
  rank: number | null
}

// Define the available evaluation strategies
export enum EvaluationStrategy {
  ExactTitle = "ExactTitle",
  // Add more strategies here later, e.g.:
  // FirstHalfTitle = 'FirstHalfTitle',
  // RandomTitleWords = 'RandomTitleWords',
}

// Configure the strategy to use for this run (can be set via ENV or default)
const CURRENT_STRATEGY: EvaluationStrategy =
  (process.env.EVALUATION_STRATEGY as EvaluationStrategy) ||
  EvaluationStrategy.ExactTitle

// Helper Functions

/**
 * Generates the search query based on the selected strategy and the document.
 * @param document The document to generate the query from.
 * @param strategy The evaluation strategy to use.
 * @returns The generated search query string, or null if generation fails.
 */
function generateSearchQuery(
  document: Document,
  strategy: EvaluationStrategy,
): string | null {
  const fields = document.fields as VespaFields
  const sddocname = fields.sddocname

  if (!sddocname || !schemaFieldMap[sddocname]) {
    Logger.warn(
      { docId: document.id, sddocname },
      "Cannot generate query: Unknown schema",
    )
    return null
  }

  const { titleField /*, potentially other fields like 'bodyField' */ } =
    schemaFieldMap[sddocname]
  const title = fields[titleField] as string | undefined

  if (typeof title !== "string" || title.trim() === "") {
    Logger.warn(
      { docId: document.id, sddocname, titleField },
      `Cannot generate query: Missing or invalid title field ('${titleField}')`,
    )
    return null
  }

  switch (strategy) {
    case EvaluationStrategy.ExactTitle:
      return title

    // --- Add cases for other strategies here ---
    // case EvaluationStrategy.FirstHalfTitle:
    //     const words = title.split(' ');
    //     return words.slice(0, Math.ceil(words.length / 2)).join(' ');

    // case EvaluationStrategy.RandomTitleWords:
    //     const titleWords = title.split(' ').filter(w => w.length > 2); // Basic filtering
    //     if (titleWords.length < 2) return title; // Fallback if too few words
    //     const numWordsToSelect = Math.max(1, Math.floor(titleWords.length / 3));
    //     // Simple random selection (might pick duplicates)
    //     let randomWords = [];
    //     for (let i = 0; i < numWordsToSelect; i++) {
    //         randomWords.push(titleWords[Math.floor(Math.random() * titleWords.length)]);
    //     }
    //     return randomWords.join(' ');

    default:
      Logger.warn({ strategy }, "Unsupported evaluation strategy")
      return null
  }
}

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

    if (!doc || !doc.id || !doc.fields) {
      Logger.warn(
        { responseData: doc },
        "Received unexpected data structure from GetRandomDocument",
      )
      return null
    }

    // Parse user-provided ID from full Vespa ID (e.g., "id:namespace:schema::user_id")
    const idParts = doc.id.split("::")
    const userId = idParts[1] || doc.fields.docId || doc.id
    const sddocname = doc.id.split(":")[2] || targetSchema

    return {
      id: userId,
      fields: {
        ...(doc.fields as Record<string, any>),
        sddocname,
      },
    }
  } catch (error) {
    Logger.error(
      { error, schema: targetSchema },
      "Failed to get random document",
    )
    return null
  }
}

async function findDocumentRank(
  docIdToFind: string,
  title: string,
): Promise<number | null> {
  Logger.debug({ docIdToFind, title }, "findDocumentRank called with:")

  let rank: number | null = null
  let offset = 0
  let totalCount = 0
  let response: any

  try {
    while (offset < MAX_RANK_TO_CHECK) {
      const searchOptions = {
        limit: HITS_PER_PAGE,
        offset: offset,
        rankProfile: SearchModes.NativeRank,
        ...(ENABLE_TRACE ? { tracelevel: 3 } : {}),
      }
      response = await searchVespa(
        title,
        USER_EMAIL_FOR_SEARCH!,
        null,
        null,
        searchOptions,
      )

      const hits = response.root.children || []
      if (offset === 0 && response.root.fields?.totalCount) {
        totalCount = response.root.fields.totalCount
      }

      if (hits.length === 0) {
        break
      }

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]
        const currentRank = offset + i + 1
        const sddocname = (hit.fields as VespaFields)?.sddocname
        const fieldMapping = sddocname ? schemaFieldMap[sddocname] : undefined
        const idField = fieldMapping?.idField

        if (!idField) {
          continue
        }

        const hitId = (hit.fields as VespaFields)?.[idField]
        Logger.debug(
          {
            sampleRank: currentRank,
            hitSchema: sddocname,
            hitIdField: idField,
            hitIdValue: hitId,
            docIdToFind,
          },
          "Comparing document IDs",
        )

        if (hitId !== undefined && hitId === docIdToFind) {
          Logger.info(
            `---> Match found at rank ${currentRank}! Comparing ${hitId} === ${docIdToFind}`,
          )
          rank = currentRank
          break
        }
      }

      if (rank !== null) {
        break
      }

      offset += HITS_PER_PAGE
      if (totalCount > 0 && offset >= totalCount) {
        break
      }
    }

    if (ENABLE_TRACE && rank === null) {
      Logger.debug(
        { trace: response.root.trace },
        "Search trace for failed ranking",
      )
    }
  } catch (error) {
    Logger.error(
      { error, docId: docIdToFind, title },
      "Failed to search for document rank",
    )
    return null
  }

  return rank
}

// Main Evaluation Logic
async function evaluateSearch() {
  Logger.info("Starting search quality evaluation across schemas...")
  Logger.info(`Using strategy: ${CURRENT_STRATEGY}`) // Log the strategy

  const results: SampleResult[] = []
  let reciprocalRanks: number[] = []
  let currentDocument: Document | null = await getRandomDocument()

  if (!currentDocument) {
    Logger.error("Could not fetch an initial document. Aborting evaluation.")
    return
  }

  for (let i = 0; i < NUM_SAMPLES && currentDocument; i++) {
    const fields = currentDocument.fields as VespaFields
    const sddocname = fields.sddocname

    if (!sddocname || !schemaFieldMap[sddocname] || !fields) {
      Logger.warn(
        { docId: currentDocument.id, sddocname },
        `Document schema ${sddocname} not in mapping or fields missing, skipping sample ${i + 1}`,
      )
      currentDocument = await getRandomDocument()
      if (!currentDocument) {
        Logger.error("Recovery failed.")
        break
      }
      continue
    }

    const { idField, titleField } = schemaFieldMap[sddocname]
    const docId = fields[idField] as string | undefined
    const title = fields[titleField] as string | undefined

    if (!docId || !title) {
      Logger.warn(
        {
          fetchedDocId: currentDocument.id,
          sddocname,
          idField,
          titleField,
          fields,
        },
        `Document missing mapped ID ('${idField}') or Title ('${titleField}') field, skipping sample ${i + 1}`,
      )
      currentDocument = await getRandomDocument()
      if (!currentDocument) {
        Logger.error("Recovery failed.")
        break
      }
      continue
    }

    if (typeof title !== "string") {
      Logger.warn(
        { docId, sddocname, title: JSON.stringify(title) },
        `Title field is not a string, skipping sample ${i + 1}`,
      )
      currentDocument = await getRandomDocument()
      if (!currentDocument) {
        Logger.error("Recovery failed.")
        break
      }
      continue
    }

    // Generate the search query using the selected strategy
    const query = generateSearchQuery(currentDocument, CURRENT_STRATEGY)

    if (!query) {
      Logger.warn(
        { docId: currentDocument.id, sddocname },
        `Failed to generate query for sample ${i + 1}, skipping.`,
      )
      currentDocument = await getRandomDocument() // Recover
      if (!currentDocument) {
        Logger.error("Recovery failed.")
        break
      }
      continue
    }

    Logger.debug(
      {
        sample: i + 1,
        docIdToTest: docId,
        schema: sddocname,
        // titleToTest: title.substring(0, 100) + (title.length > 100 ? '...' : ''),
        queryToTest:
          query.substring(0, 100) + (query.length > 100 ? "..." : ""), // Log the generated query
        strategy: CURRENT_STRATEGY,
        documentObjectType: "Document", // Simplified type name
      },
      "Preparing to call findDocumentRank",
    )

    Logger.info(
      `[Sample ${i + 1}/${NUM_SAMPLES}] Schema: ${sddocname}, ID: ${docId}, Query (${CURRENT_STRATEGY}): "${query.substring(0, 100)}${query.length > 100 ? "..." : ""}"`,
    )

    const rank = await findDocumentRank(docId, query) // Use the generated query
    // Store the original title along with the query for reference in results
    results.push({ docId, schema: sddocname, title: title || "N/A", rank })

    if (rank !== null && rank <= MAX_RANK_TO_CHECK) {
      reciprocalRanks.push(1 / rank)
      Logger.info(` -> Found at Rank: ${rank}`)
    } else {
      reciprocalRanks.push(0)
      Logger.info(` -> Not found within top ${MAX_RANK_TO_CHECK}`)
    }

    currentDocument = await getRandomDocument()
    if (!currentDocument) {
      Logger.error("Failed to get next document to test. Aborting evaluation.")
      break
    }

    await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
  }

  // Calculate and Report Metrics
  if (reciprocalRanks.length > 0) {
    const mrr =
      reciprocalRanks.reduce((sum, r) => sum + r, 0) / reciprocalRanks.length
    const successAt3 =
      results.filter((r) => r.rank !== null && r.rank <= 3).length /
      results.length
    const successRate =
      results.filter((r) => r.rank !== null && r.rank <= MAX_RANK_TO_CHECK)
        .length / results.length

    Logger.info(`
--- Evaluation Complete ---
Total Samples Attempted: ${NUM_SAMPLES}
Total Samples Evaluated: ${results.length}
Mean Reciprocal Rank (MRR): ${mrr.toFixed(4)}
Success@3: ${(successAt3 * 100).toFixed(2)}%
Success Rate (found within Top ${MAX_RANK_TO_CHECK}): ${(successRate * 100).toFixed(2)}%
`)

    // Schema-specific metrics
    const metricsBySchema: Record<
      string,
      { mrr: number; successAt3: number; successRate: number; count: number }
    > = {}
    results.forEach((r) => {
      const schema = r.schema
      if (!metricsBySchema[schema]) {
        metricsBySchema[schema] = {
          mrr: 0,
          successAt3: 0,
          successRate: 0,
          count: 0,
        }
      }
      metricsBySchema[schema].mrr += r.rank ? 1 / r.rank : 0
      metricsBySchema[schema].successAt3 += r.rank && r.rank <= 3 ? 1 : 0
      metricsBySchema[schema].successRate +=
        r.rank && r.rank <= MAX_RANK_TO_CHECK ? 1 : 0
      metricsBySchema[schema].count += 1
    })
    Object.entries(metricsBySchema).forEach(([schema, metrics]) => {
      Logger.info(`Schema: ${schema}`)
      Logger.info(`  Samples: ${metrics.count}`)
      Logger.info(`  MRR: ${(metrics.mrr / metrics.count).toFixed(4)}`)
      Logger.info(
        `  Success@3: ${((metrics.successAt3 / metrics.count) * 100).toFixed(2)}%`,
      )
      Logger.info(
        `  Success Rate: ${((metrics.successRate / metrics.count) * 100).toFixed(2)}%`,
      )
    })

    // Save results to file
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      // Include strategy in the filename
      const timestampedFilename = `evaluation_results_${CURRENT_STRATEGY}_${timestamp}.json`
      fs.writeFileSync(timestampedFilename, JSON.stringify(results, null, 2))
      Logger.info(`Detailed results saved to ${timestampedFilename}`)

      // Save poor rankings
      const poorRankings = results.filter((r) => r.rank === null || r.rank > 10)
      if (poorRankings.length > 0) {
        // Include strategy in the poor rankings filename
        fs.writeFileSync(
          `poor_rankings_${CURRENT_STRATEGY}_${timestamp}.json`,
          JSON.stringify(poorRankings, null, 2),
        )
        Logger.info(
          `Poor rankings saved to poor_rankings_${CURRENT_STRATEGY}_${timestamp}.json`,
        )
      }
    } catch (error) {
      Logger.error({ error }, "Failed to save evaluation results to file.")
    }
  } else {
    Logger.warn("No samples were successfully processed.")
  }
}

evaluateSearch().catch((error) => {
  Logger.error({ error }, "Unhandled error during search evaluation")
  process.exit(1)
})
