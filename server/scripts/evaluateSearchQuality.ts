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
import path from "path" // Ensure path module is imported
import crypto from "crypto" // Import crypto module
import { SearchModes } from "@xyne/vespa-ts/types"
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

const NUM_SAMPLES = parseInt(process.env.NUM_SAMPLES || "100", 10) // Default to 100 samples per run
const NUM_RUNS = parseInt(process.env.EVALUATION_NUM_RUNS || "3", 10) // Default to 3 evaluation runs
const MAX_RANK_TO_CHECK = parseInt(process.env.MAX_RANK_TO_CHECK || "100", 10) // Default to 100
const HITS_PER_PAGE = 10
const VESPA_NAMESPACE = "namespace" // TODO: Replace with your actual Vespa namespace
const VESPA_CLUSTER_NAME = "my_content" // TODO: Replace with your actual cluster name
const DELAY_MS = parseInt(process.env.EVALUATION_DELAY_MS || "15", 10)
const ENABLE_TRACE = process.env.ENABLE_TRACE === "true"
const DEBUG_POOR_RANKINGS = process.env.DEBUG_POOR_RANKINGS === "true"
const POOR_RANK_THRESHOLD = parseInt(
  process.env.POOR_RANK_THRESHOLD || "10",
  10,
)

// Define the output directory relative to the server directory
const OUTPUT_DIR = path.join(__dirname, "..", "eval-results", "search-quality") // Now inside server/eval-results/

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
  { idField: string; titleField: string; bodyField?: string }
> = {
  [fileSchema]: { idField: "docId", titleField: "title", bodyField: "chunks" },
  [mailSchema]: {
    idField: "docId",
    titleField: "subject",
    bodyField: "chunks",
  },
  [userSchema]: { idField: "docId", titleField: "name" },
  [eventSchema]: {
    idField: "docId",
    titleField: "name",
    bodyField: "description",
  },
  [mailAttachmentSchema]: {
    idField: "docId",
    titleField: "filename",
    bodyField: "chunks",
  },
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
  query: string // Add query to sample result for analysis
}

// --- Types for Failure Analysis (Copied from analyzeSearchFailures.ts) ---
interface DebugFailureInfo {
  // Renamed from DebugInfo to avoid conflict
  docId: string
  query: string
  foundAtRank: number | null
  debugInfo: {
    query: string
    docIdToFind: string
    topResults: Array<{
      rank: number | null
      schema: string
      title: string
      docId: string
      matchDetails: Record<string, any>
    }>
    trace: any // Keep trace for debugging
  }
}

interface SchemaAnalysis {
  schema: string
  totalDocuments: number
  notFoundCount: number
  poorRankingCount: number
  commonIssues: Record<string, number>
  examples: Array<{
    query: string
    docId: string
    foundAtRank: number | null
    likelyIssue: string
    topResults: Array<any>
  }>
}
// --- End Types for Failure Analysis ---

// Define the available evaluation strategies
export enum EvaluationStrategy {
  ExactTitle = "ExactTitle",
  BodyPhrase = "BodyPhrase",
  RandomTitleWords = "RandomTitleWords",
  // Add more strategies here later, e.g.:
  // FirstHalfTitle = 'FirstHalfTitle',
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

  const { titleField, bodyField } = schemaFieldMap[sddocname]
  const title = fields[titleField] as string | undefined

  switch (strategy) {
    case EvaluationStrategy.ExactTitle: {
      if (typeof title !== "string" || title.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, titleField },
          `Cannot generate ExactTitle query: Missing or invalid title field ('${titleField}')`,
        )
        return null
      }
      return title
    }

    case EvaluationStrategy.BodyPhrase: {
      if (!bodyField) {
        Logger.warn(
          { docId: document.id, sddocname },
          `Cannot generate BodyPhrase query: No bodyField defined for schema '${sddocname}'`,
        )
        return null
      }
      const bodyFieldValue = fields[bodyField]
      let bodyText: string | undefined

      // Check if the body field is 'chunks' and handle array joining
      if (bodyField === "chunks") {
        if (Array.isArray(bodyFieldValue) && bodyFieldValue.length > 0) {
          // Join array elements (assuming they are strings)
          bodyText = bodyFieldValue.map(String).join("\\n") // Join with real newline
        } else {
          Logger.warn(
            { docId: document.id, sddocname, bodyField },
            `Cannot generate BodyPhrase query: Field '${bodyField}' is not a non-empty array or is empty.`,
          )
          return null // Return null if chunks are empty or not an array
        }
      } else {
        // Handle regular string body field
        bodyText = bodyFieldValue as string | undefined
      }

      if (typeof bodyText !== "string" || bodyText.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, bodyField },
          `Cannot generate BodyPhrase query: Missing or invalid body content after processing field ('${bodyField}')`,
        )
        return null
      }
      // Extract first 5-6 words (simple approach)
      const words = bodyText
        .trim()
        .split(/\\s+/)
        .filter((w) => w.length > 0) // Split by whitespace and filter empty strings
      const phrase = words.slice(0, 6).join(" ") // Take first 6 words
      if (phrase.length < 5) {
        // Keep minimum length check
        Logger.warn(
          { docId: document.id, sddocname, bodyField, phrase },
          `Cannot generate BodyPhrase query: Extracted phrase too short ('${phrase}')`,
        )
        return null
      }
      return phrase
    }

    case EvaluationStrategy.RandomTitleWords: {
      if (typeof title !== "string" || title.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, titleField },
          `Cannot generate RandomTitleWords query: Missing or invalid title field ('${titleField}')`,
        )
        return null
      }
      const words = title
        .trim()
        .split(/\\s+/)
        .filter((w) => w.length > 0) // Split and filter empty strings
      const minWords = 3 // Configurable: minimum words required in title

      if (words.length < minWords) {
        Logger.warn(
          { docId: document.id, sddocname, title, wordCount: words.length },
          `Cannot generate RandomTitleWords query: Title has fewer than ${minWords} words.`,
        )
        return null
      }

      // Simple random sample without replacement (shuffle and pick first N)
      const numWordsToSelect = minWords // Select exactly 3 words for consistency
      // Fisher-Yates (Knuth) shuffle for better randomness
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[words[i], words[j]] = [words[j], words[i]]
      }
      const selectedWords = words.slice(0, numWordsToSelect)

      return selectedWords.join(" ")
    }

    default:
      // Should not happen if CURRENT_STRATEGY is validated, but good practice
      const exhaustiveCheck: never = strategy
      Logger.warn(
        { strategy: exhaustiveCheck },
        "Unsupported evaluation strategy encountered in generateSearchQuery",
      )
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
  query: string,
): Promise<{ rank: number | null; debugPayload: DebugFailureInfo | null }> {
  // Return debug payload
  Logger.debug({ docIdToFind, query }, "findDocumentRank called with:")

  let rank: number | null = null
  let offset = 0
  let totalCount = 0
  let response: any
  let collectedDebugInfo: DebugFailureInfo | null = null // Store full debug info here

  try {
    while (offset < MAX_RANK_TO_CHECK) {
      const searchOptions = {
        limit: HITS_PER_PAGE,
        offset: offset,
        rankProfile: SearchModes.NativeRank, // Or your custom hybrid rank profile name
        ...(ENABLE_TRACE || DEBUG_POOR_RANKINGS ? { tracelevel: 5 } : {}),
      }
      // Note: The searchVespa call here needs to be able to handle the hybrid query logic
      // if you implement it as discussed (searching multiple fields).
      // Assuming searchVespa takes a raw query string that can be YQL or similar.
      response = await searchVespa(
        query, // Use the generated query string (e.g., the exact title)
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

      // Construct base debug info if needed (only on first page for efficiency)
      if (DEBUG_POOR_RANKINGS && offset === 0) {
        collectedDebugInfo = {
          docId: docIdToFind,
          query: query,
          foundAtRank: null, // Will be updated if found
          debugInfo: {
            // Correct structure
            query: query,
            docIdToFind: docIdToFind,
            topResults: hits.slice(0, 10).map((hit: any, index: number) => {
              // Capture top 10 and index
              const fields = hit.fields as VespaFields
              const sddocname = fields.sddocname
              const fieldMapping = sddocname
                ? schemaFieldMap[sddocname]
                : undefined
              const resultRank = offset + index + 1 // Calculate rank for this specific result in the map
              return {
                rank: resultRank, // Use the calculated positional rank
                schema: sddocname || "unknown",
                title:
                  fieldMapping && fields[fieldMapping.titleField] !== undefined
                    ? String(fields[fieldMapping.titleField])
                    : "unknown",
                docId:
                  fieldMapping && fields[fieldMapping.idField] !== undefined
                    ? String(fields[fieldMapping.idField])
                    : "unknown",
                matchDetails: hit.matchfeatures || {},
              }
            }),
            trace: response.root.trace, // Include trace
          },
        }
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
      if (totalCount > 0 && offset >= totalCount) {
        break // Stop if we've checked all results
      }
    }

    // Save individual debug file if debugging is enabled and rank is poor/null
    if (
      DEBUG_POOR_RANKINGS &&
      collectedDebugInfo &&
      (rank === null || rank > POOR_RANK_THRESHOLD)
    ) {
      // Delay saving until the end of all runs? Or save here for immediate feedback?
      // Saving here provides immediate feedback but scatters files.
      // Let's keep saving here for now as per original logic.
      ensureDirectoryExists(OUTPUT_DIR) // Ensure directory exists before saving

      // Use a hash of the docId to prevent overly long filenames
      const docIdHash = crypto
        .createHash("sha256")
        .update(docIdToFind)
        .digest("hex")
      const debugFilename = path.join(
        OUTPUT_DIR,
        `debug_${docIdHash}_${new Date().getTime()}.json`, // Use hash instead of raw docId
      )
      try {
        // Update rank one last time before saving
        collectedDebugInfo.foundAtRank = rank
        fs.writeFileSync(
          debugFilename,
          JSON.stringify(collectedDebugInfo, null, 2), // Save the collected info
        )
        Logger.info(
          `Debug info for poorly ranked document saved to ${debugFilename}`,
        )
      } catch (error) {
        Logger.error({ error, docId: docIdToFind }, "Failed to save debug info")
        // Don't nullify collectedDebugInfo here, maybe analysis can still use it
      }
    } else if (
      DEBUG_POOR_RANKINGS &&
      !collectedDebugInfo &&
      (rank === null || rank > POOR_RANK_THRESHOLD)
    ) {
      // Case where rank is poor but no debug info was collected (e.g., error during first page search)
      Logger.warn(
        { docId: docIdToFind, rank },
        "Poor rank detected but no debug info collected, possibly due to search error on first page.",
      )
    }
  } catch (error) {
    Logger.error(
      { error, docId: docIdToFind, query },
      "Failed to search for document rank",
    )
    // Nullify collectedDebugInfo on search error? Or keep partial? Let's keep it for now.
    return { rank: null, debugPayload: collectedDebugInfo } // Return null rank and potentially partial debug info
  }

  // Return rank and the full debug payload (which is null if not debugging or rank is good)
  return {
    rank,
    debugPayload:
      DEBUG_POOR_RANKINGS && (rank === null || rank > POOR_RANK_THRESHOLD)
        ? collectedDebugInfo
        : null,
  }
}

// --- Failure Analysis Functions (Adapted from analyzeSearchFailures.ts) ---

/**
 * Perform failure analysis on collected debug information.
 */
function performFailureAnalysis(
  debugData: DebugFailureInfo[],
  outputDir: string,
) {
  if (!DEBUG_POOR_RANKINGS || debugData.length === 0) {
    Logger.info(
      "Skipping failure analysis: Debugging not enabled or no poor rankings found across all runs.",
    )
    return
  }

  Logger.info(`--- Starting Failure Analysis (${debugData.length} entries) ---`)

  // Group by schema for analysis
  const schemaGroups: Record<string, DebugFailureInfo[]> = {}

  debugData.forEach((info) => {
    // Determine schema
    let schema = "unknown"
    const topResults = info.debugInfo?.topResults || []
    const matchingResult = topResults.find((r) => r.docId === info.docId)

    if (matchingResult && matchingResult.schema) {
      schema = matchingResult.schema
    } else {
      // Infer from docId format (keep simple logic)
      if (info.docId.includes("@") || info.docId.match(/^[0-9a-f]{16}$/)) {
        schema = mailSchema
      } else if (info.docId.match(/^[0-9A-Za-z_-]{33,}$/)) {
        schema = mailAttachmentSchema
      } else if (info.docId.match(/^[0-9A-Za-z_-]{20,32}$/)) {
        schema = fileSchema
      } else if (info.docId.match(/^u:/)) {
        // Example for user schema if prefixed
        schema = userSchema
      } else if (info.docId.match(/^ev:/)) {
        // Example for event schema if prefixed
        schema = eventSchema
      }
      // Add more robust schema detection if needed
    }

    if (!schemaGroups[schema]) {
      schemaGroups[schema] = []
    }
    schemaGroups[schema].push(info)
  })

  // Analyze issues for each schema
  const schemaAnalyses: SchemaAnalysis[] = []

  for (const [schema, groupDebugInfos] of Object.entries(schemaGroups)) {
    Logger.info(
      `Analyzing ${groupDebugInfos.length} failures for schema: ${schema}`,
    )

    const analysis: SchemaAnalysis = {
      schema,
      totalDocuments: groupDebugInfos.length,
      notFoundCount: groupDebugInfos.filter((info) => info.foundAtRank === null)
        .length,
      poorRankingCount: groupDebugInfos.filter(
        (info) => info.foundAtRank !== null,
      ).length,
      commonIssues: {},
      examples: [],
    }

    // Analyze each debug info to identify common patterns
    for (const info of groupDebugInfos) {
      try {
        // Keep inner try-catch for individual analysis errors
        let likelyIssue = "Unknown"

        // Check if document wasn't found at all
        if (info.foundAtRank === null) {
          if (info.query.length < 3) {
            likelyIssue = "Query too short"
          } else if (info.query.includes(".") && schema === fileSchema) {
            likelyIssue = "File extension handling"
          } else if (
            /[^\w\s]/.test(info.query) &&
            info.debugInfo?.topResults?.length === 0
          ) {
            likelyIssue = "Special characters in query"
          } else if (
            schema === mailAttachmentSchema &&
            info.query.includes(".pdf")
          ) {
            likelyIssue = "PDF filename matching"
          } else {
            likelyIssue = "Document not indexed or permissions issue"
          }
        } else {
          // Document found but ranked poorly (already filtered by POOR_RANK_THRESHOLD)
          const topTitles =
            info.debugInfo?.topResults?.map(
              (r) => (r.title || "").toLowerCase(), // Safely handle potentially undefined title
            ) || []
          const queryTokens = info.query.toLowerCase().split(/\s+/)

          if (
            topTitles.some((title) =>
              queryTokens.every((token) => title && title.includes(token)),
            )
          ) {
            // Check title exists
            likelyIssue = "Term weighting issues"
          } else if (schema === mailAttachmentSchema) {
            likelyIssue = "Attachment filename tokenization"
          } else {
            likelyIssue = "Ranking algorithm prioritization"
          }
        }

        // Count common issues
        analysis.commonIssues[likelyIssue] =
          (analysis.commonIssues[likelyIssue] || 0) + 1

        // Add to examples (limit to keep analysis manageable)
        if (analysis.examples.length < 5) {
          analysis.examples.push({
            query: info.query,
            docId: info.docId,
            foundAtRank: info.foundAtRank,
            likelyIssue,
            topResults: info.debugInfo?.topResults || [],
          })
        }
      } catch (error) {
        Logger.error(
          {
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            docId: info?.docId,
            query: info?.query,
          },
          "Error analyzing single debug info entry during report generation. Skipping this entry.",
        )
        analysis.commonIssues["Analysis Error"] =
          (analysis.commonIssues["Analysis Error"] || 0) + 1
      }
    }
    schemaAnalyses.push(analysis)
  }

  // Generate recommendations
  const recommendations = generateFailureRecommendations(schemaAnalyses) // Renamed function

  // Write the analysis report
  writeFailureAnalysisReport(schemaAnalyses, recommendations, outputDir) // Renamed function

  Logger.info(`--- Failure Analysis Complete ---`)
}

/**
 * Generate specific recommendations based on the failure analysis (Adapted)
 */
function generateFailureRecommendations(
  analyses: SchemaAnalysis[],
): Record<string, string[]> {
  const recommendations: Record<string, string[]> = {}

  analyses.forEach((analysis) => {
    const schema = analysis.schema
    recommendations[schema] = []

    // Generate schema-specific recommendations
    if (analysis.notFoundCount > analysis.poorRankingCount) {
      recommendations[schema].push(
        "Review document indexing/permissions to ensure all target documents are searchable.",
      )
      if (schema === mailAttachmentSchema)
        recommendations[schema].push(
          "Improve attachment filename tokenization for better matching.",
        )
      if (schema === fileSchema)
        recommendations[schema].push(
          "Ensure file metadata (esp. extensions) is normalized/handled correctly.",
        )
    } else if (analysis.poorRankingCount > 0) {
      recommendations[schema].push(
        "Review ranking weights/profiles to prioritize matches in primary fields (title/subject/name/filename).",
      )
      if (schema === mailSchema)
        recommendations[schema].push(
          "Increase boost for subject matches over body content.",
        )
      if (schema === eventSchema)
        recommendations[schema].push(
          "Prioritize exact name matches over description matches.",
        )
    }

    // Add recommendations based on common issues
    const sortedIssues = Object.entries(analysis.commonIssues)
      .filter(([issue]) => issue !== "Analysis Error") // Exclude analysis errors
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    sortedIssues.forEach(([issue, count]) => {
      const percentage = Math.round((count / analysis.totalDocuments) * 100)
      const issueText = `(${percentage}% of failures)`
      switch (issue) {
        case "Query too short":
          recommendations[schema].push(
            `Improve handling of short queries ${issueText}.`,
          )
          break
        case "Special characters in query":
          recommendations[schema].push(
            `Enhance tokenization for special characters ${issueText}.`,
          )
          break
        case "File extension handling":
          recommendations[schema].push(
            `Implement special handling for file extensions ${issueText}.`,
          )
          break
        case "PDF filename matching":
          recommendations[schema].push(
            `Add specific rules/tokenization for PDF filenames ${issueText}.`,
          )
          break
        case "Term weighting issues":
          recommendations[schema].push(
            `Adjust term weighting to prioritize primary field matches ${issueText}.`,
          )
          break
        case "Attachment filename tokenization":
          recommendations[schema].push(
            `Improve tokenization/matching for attachment filenames ${issueText}.`,
          )
          break
        case "Ranking algorithm prioritization":
          recommendations[schema].push(
            `Review ranking signals/profile for relevance ${issueText}.`,
          )
          break
      }
    })
    if (analysis.commonIssues["Analysis Error"] > 0) {
      recommendations[schema].push(
        `Investigate ${analysis.commonIssues["Analysis Error"]} analysis errors (check logs).`,
      )
    }
  })

  return recommendations
}

/**
 * Write the full failure analysis report (Adapted)
 */
function writeFailureAnalysisReport(
  analyses: SchemaAnalysis[],
  recommendations: Record<string, string[]>,
  outputDir: string,
) {
  const reportFilename = path.join(outputDir, "search_failure_analysis.md")
  let report = `# Search Quality Failure Analysis Report\nGenerated: ${new Date().toISOString()}\n\n## Overview\nThis report analyzes search failures based on runs with DEBUG_POOR_RANKINGS=true to identify patterns and recommend improvements.\n\n`

  // Summary Metrics
  report += `## Summary Metrics\n\n| Schema | Total Failures | Not Found | Poorly Ranked | Top Issues |\n`
  report += `|--------|---------------|-----------|---------------|------------|\n`
  analyses.forEach((analysis) => {
    const topIssues = Object.entries(analysis.commonIssues)
      .filter(([issue]) => issue !== "Analysis Error") // Exclude analysis errors
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([issue, count]) => `${issue} (${count})`)
      .join(", ")
    report += `| ${analysis.schema} | ${analysis.totalDocuments} | ${analysis.notFoundCount} | ${analysis.poorRankingCount} | ${topIssues || "N/A"} |\n`
  })

  // Recommendations
  report += `\n## Recommendations by Schema\n\n`
  Object.entries(recommendations).forEach(([schema, schemaRecommendations]) => {
    if (schemaRecommendations.length > 0) {
      report += `### ${schema}\n\n`
      schemaRecommendations.forEach((rec) => {
        report += `- ${rec}\n`
      })
      report += `\n`
    }
  })

  // Detailed Analysis
  report += `## Detailed Analysis\n\n`
  analyses.forEach((analysis) => {
    report += `### ${analysis.schema}\n\n`
    report += `- Total failures analyzed: ${analysis.totalDocuments}\n`
    report += `- Documents not found: ${analysis.notFoundCount}\n`
    report += `- Documents ranked poorly (Rank > ${POOR_RANK_THRESHOLD}): ${analysis.poorRankingCount}\n\n`

    // Common Issues
    report += `#### Common Issues\n\n`
    Object.entries(analysis.commonIssues)
      .sort((a, b) => b[1] - a[1])
      .forEach(([issue, count]) => {
        const percentage = Math.round((count / analysis.totalDocuments) * 100)
        report += `- ${issue}: ${count} occurrences (${percentage}%)\n`
      })

    // Example Failures
    if (analysis.examples.length > 0) {
      report += `\n#### Example Failures (up to 5)\n\n`
      analysis.examples.forEach((example, index) => {
        report += `**Example ${index + 1}:**\n`
        report += `- Query: \`${example.query}\`\n` // Use backticks for query
        report += `- Document ID: \`${example.docId}\`\n`
        report += `- Found at rank: ${example.foundAtRank === null ? "Not found" : example.foundAtRank}\n`
        report += `- Likely issue: ${example.likelyIssue}\n`
        if (example.topResults.length > 0) {
          report += `- Top results instead:\n`
          example.topResults.slice(0, 3).forEach((result, i) => {
            // Show top 3
            report += `  ${i + 1}. "${result.title || "N/A"}" (${result.schema || "unknown"}) - DocID: \`${result.docId || "unknown"}\`\n`
          })
        }
        report += `\n`
      })
    }
    report += `\n`
  })

  // Write the report
  try {
    fs.writeFileSync(reportFilename, report)
    Logger.info(`Failure analysis report saved to ${reportFilename}`)
  } catch (error) {
    Logger.error(
      { error, reportFilename },
      "Failed to write failure analysis report.",
    )
  }
}

// --- End Failure Analysis Functions ---

// --- Evaluation Types ---
interface SingleRunMetrics {
  results: SampleResult[]
  reciprocalRanks: number[]
  collectedDebugData: DebugFailureInfo[]
  evaluatedSamples: number
}

interface AveragedMetrics {
  mrr: number
  meanRank: number
  medianRank: number
  successAt3: number
  successAt5: number
  successAt10: number
  successRate: number // Success within MAX_RANK_TO_CHECK
  rankDistribution: Record<string, number> // Store counts
  metricsBySchema: Record<
    string,
    {
      mrrSum: number
      ranks: number[]
      successAt3Count: number
      successAt5Count: number
      successAt10Count: number
      successRateCount: number
      count: number
    }
  >
}
// --- End Evaluation Types ---

/**
 * Performs a single evaluation run for NUM_SAMPLES.
 */
async function runSingleEvaluation(
  runNumber: number,
): Promise<SingleRunMetrics> {
  Logger.info(
    `--- Starting Evaluation Run #${runNumber}/${NUM_RUNS} (Samples: ${NUM_SAMPLES}) ---`,
  )

  const results: SampleResult[] = []
  const reciprocalRanks: number[] = []
  const collectedDebugData: DebugFailureInfo[] = [] // Store debug data here if enabled
  let evaluatedSamples = 0
  const MAX_FETCH_RETRIES_PER_SAMPLE = 5 // Max attempts to find a suitable doc per sample

  while (evaluatedSamples < NUM_SAMPLES) {
    Logger.debug(
      `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Starting processing...`,
    )
    let currentDocument: Document | null = null
    let query: string | null = null
    let docToEvaluate: Document | null = null // Use this to store the valid doc found
    let docId: string | undefined = undefined
    let originalTitle: string | undefined = undefined
    let sddocname: string | undefined = undefined
    let foundSuitableDocument = false

    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES_PER_SAMPLE; attempt++) {
      Logger.debug(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Fetch attempt ${attempt}/${MAX_FETCH_RETRIES_PER_SAMPLE}...`,
      )
      currentDocument = await getRandomDocument()

      if (!currentDocument) {
        Logger.warn(
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Failed to fetch document. Retrying...`,
        )
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2)) // Small delay before retrying fetch
        continue
      }

      const tempDoc = currentDocument // Use temporary variable for checks
      const fields = tempDoc.fields as VespaFields
      const tempSddocname = fields.sddocname

      // --- Basic Document Validation ---
      if (!tempSddocname || !schemaFieldMap[tempSddocname] || !fields) {
        Logger.debug(
          { docId: tempDoc.id, sddocname: tempSddocname, attempt },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Document schema '${tempSddocname}' not in mapping or fields missing. Trying next attempt.`,
        )
        continue
      }

      const { idField, titleField } = schemaFieldMap[tempSddocname]
      const tempDocId = fields[idField] as string | undefined
      const tempOriginalTitle = fields[titleField] as string | undefined

      if (!tempDocId || typeof tempOriginalTitle !== "string") {
        Logger.debug(
          {
            fetchedDocId: tempDoc.id,
            sddocname: tempSddocname,
            attempt,
            hasDocId: !!tempDocId,
            titleType: typeof tempOriginalTitle,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Document missing mapped ID or valid Title field. Trying next attempt.`,
        )
        continue
      }

      // --- Strategy Specific Validation ---
      if (
        CURRENT_STRATEGY === EvaluationStrategy.BodyPhrase &&
        !schemaFieldMap[tempSddocname].bodyField
      ) {
        Logger.debug(
          {
            docId: tempDoc.id,
            sddocname: tempSddocname,
            strategy: CURRENT_STRATEGY,
            attempt,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Schema '${tempSddocname}' has no bodyField for BodyPhrase strategy. Trying next attempt.`,
        )
        continue
      }

      // --- Generate Query ---
      const tempQuery = generateSearchQuery(tempDoc, CURRENT_STRATEGY)

      if (!tempQuery) {
        Logger.debug(
          {
            docId: tempDoc.id,
            sddocname: tempSddocname,
            strategy: CURRENT_STRATEGY,
            attempt,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Failed to generate query for document using strategy ${CURRENT_STRATEGY}. Trying next attempt.`,
        )
        continue
      }

      // --- If we reach here, the document and query are suitable ---
      Logger.info(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Found suitable document (ID: ${tempDocId}) on attempt ${attempt}.`,
      )
      docToEvaluate = tempDoc
      query = tempQuery
      docId = tempDocId
      originalTitle = tempOriginalTitle
      sddocname = tempSddocname
      foundSuitableDocument = true
      break // Exit the inner retry loop
    } // End inner retry loop

    // --- Process the found document or skip sample ---
    if (foundSuitableDocument && docToEvaluate && query && docId && sddocname) {
      // A suitable document was found within the retries
      Logger.info(
        `[Run ${runNumber}/${NUM_RUNS}, Sample ${evaluatedSamples + 1}/${NUM_SAMPLES}] Evaluating Schema: ${sddocname}, ID: ${docId}, Query (${CURRENT_STRATEGY}): "${query.substring(0, 100)}${query.length > 100 ? "..." : ""}"`,
      )
      Logger.debug(
        {
          /* ... debug details ... */
        },
        "Preparing to call findDocumentRank",
      )

      // Call findDocumentRank and get both rank and potential debug payload
      const { rank, debugPayload } = await findDocumentRank(docId, query)

      results.push({
        docId,
        schema: sddocname,
        title: originalTitle || "N/A",
        rank,
        query, // Include query in sample result
      })

      // Add debug payload to our collection if it exists
      if (debugPayload) {
        collectedDebugData.push(debugPayload)
      }

      if (rank !== null && rank <= MAX_RANK_TO_CHECK) {
        reciprocalRanks.push(1 / rank)
        Logger.info(` -> Found at Rank: ${rank}`)
      } else {
        reciprocalRanks.push(0)
        Logger.info(` -> Not found within top ${MAX_RANK_TO_CHECK}`)
      }

      // --- Evaluation for this sample number is complete ---
      evaluatedSamples++ // Increment the count of successfully evaluated samples
    } else {
      // Failed to find a suitable document after MAX_FETCH_RETRIES_PER_SAMPLE attempts
      Logger.error(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Failed to find a suitable document after ${MAX_FETCH_RETRIES_PER_SAMPLE} attempts. Skipping this sample number for this run.`,
      )
      evaluatedSamples++ // Increment anyway to prevent infinite loops
      Logger.warn(
        `Run #${runNumber}, Sample #${evaluatedSamples}: Incrementing evaluated count despite failure to find suitable doc, to ensure loop termination.`,
      )
    }

    // Only delay if we are continuing the loop for the next sample in this run
    if (evaluatedSamples < NUM_SAMPLES) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  } // End outer while loop (for samples)

  Logger.info(`--- Evaluation Run #${runNumber}/${NUM_RUNS} Finished ---`)
  // Add a note about total processed vs target for this run
  if (evaluatedSamples < NUM_SAMPLES) {
    Logger.warn(
      `Target was ${NUM_SAMPLES} samples for Run #${runNumber}, but loop finished after processing ${evaluatedSamples}. This might happen if finding suitable documents consistently failed in this run.`,
    )
  }

  return {
    results,
    reciprocalRanks,
    collectedDebugData,
    evaluatedSamples,
  }
}

/**
 * Calculates average metrics across multiple evaluation runs.
 */
function calculateAverages(
  runMetrics: SingleRunMetrics[],
  totalEvaluatedSamples: number,
): AveragedMetrics {
  // Consolidate all results and reciprocal ranks
  const allResults = runMetrics.flatMap((run) => run.results)
  const allReciprocalRanks = runMetrics.flatMap((run) => run.reciprocalRanks)

  const numEvaluated = allResults.length

  // Calculate overall metrics
  const mrr =
    numEvaluated > 0
      ? allReciprocalRanks.reduce((sum, r) => sum + r, 0) / numEvaluated
      : 0

  const foundDocuments = allResults.filter((r) => r.rank !== null)
  const meanRank =
    foundDocuments.length > 0
      ? foundDocuments.reduce((sum, r) => sum + (r.rank || 0), 0) /
        foundDocuments.length
      : 0

  let medianRank = 0
  if (foundDocuments.length > 0) {
    const sortedRanks = foundDocuments
      .map((r) => r.rank || 0)
      .sort((a, b) => a - b)
    const midIndex = Math.floor(sortedRanks.length / 2)
    medianRank =
      sortedRanks.length % 2 === 0
        ? (sortedRanks[midIndex - 1] + sortedRanks[midIndex]) / 2
        : sortedRanks[midIndex]
  }

  const successAt3 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 3).length /
        numEvaluated
      : 0
  const successAt5 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 5).length /
        numEvaluated
      : 0
  const successAt10 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 10).length /
        numEvaluated
      : 0
  const successRate =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= MAX_RANK_TO_CHECK)
          .length / numEvaluated
      : 0

  // Calculate rank distribution counts (based on all results)
  const rankDistributionCounts: Record<string, number> = {
    "1": 0,
    "2-3": 0,
    "4-5": 0,
    "6-10": 0,
    "11-20": 0,
    "21-50": 0,
    "51-100": 0,
    not_found: 0,
  }
  allResults.forEach((r) => {
    if (r.rank === null) {
      rankDistributionCounts.not_found++
    } else if (r.rank === 1) {
      rankDistributionCounts["1"]++
    } else if (r.rank <= 3) {
      rankDistributionCounts["2-3"]++
    } else if (r.rank <= 5) {
      rankDistributionCounts["4-5"]++
    } else if (r.rank <= 10) {
      rankDistributionCounts["6-10"]++
    } else if (r.rank <= 20) {
      rankDistributionCounts["11-20"]++
    } else if (r.rank <= 50) {
      rankDistributionCounts["21-50"]++
    } else if (r.rank <= MAX_RANK_TO_CHECK) {
      rankDistributionCounts["51-100"]++
    } else {
      rankDistributionCounts.not_found++ // Treat ranks > MAX_RANK_TO_CHECK as not found for distribution
    }
  })

  // Calculate metrics by schema (based on all results)
  const metricsBySchema: Record<
    string,
    {
      mrrSum: number
      ranks: number[]
      successAt3Count: number
      successAt5Count: number
      successAt10Count: number
      successRateCount: number
      count: number // Total samples for this schema across all runs
    }
  > = {}

  allResults.forEach((r) => {
    const schema = r.schema || "unknown"
    if (!metricsBySchema[schema]) {
      metricsBySchema[schema] = {
        mrrSum: 0,
        ranks: [],
        successAt3Count: 0,
        successAt5Count: 0,
        successAt10Count: 0,
        successRateCount: 0,
        count: 0,
      }
    }
    metricsBySchema[schema].mrrSum += r.rank ? 1 / r.rank : 0
    if (r.rank !== null) {
      metricsBySchema[schema].ranks.push(r.rank)
      if (r.rank <= 3) metricsBySchema[schema].successAt3Count++
      if (r.rank <= 5) metricsBySchema[schema].successAt5Count++
      if (r.rank <= 10) metricsBySchema[schema].successAt10Count++
      if (r.rank <= MAX_RANK_TO_CHECK)
        metricsBySchema[schema].successRateCount++
    }
    metricsBySchema[schema].count += 1
  })

  return {
    mrr,
    meanRank,
    medianRank,
    successAt3,
    successAt5,
    successAt10,
    successRate,
    rankDistribution: rankDistributionCounts, // Return counts
    metricsBySchema, // Return calculated counts and sums per schema
  }
}

/**
 * Generate the text content for the performance summary report file using averaged data.
 */
function generateSummaryReportContent(
  averagedMetrics: AveragedMetrics,
  totalEvaluatedSamples: number,
): string {
  const {
    mrr,
    meanRank,
    medianRank,
    successAt3,
    successAt5,
    successAt10,
    successRate,
    rankDistribution,
    metricsBySchema,
  } = averagedMetrics

  let content = `
===========================================
SEARCH PERFORMANCE SUMMARY (${CURRENT_STRATEGY})
===========================================
Generated: ${new Date().toISOString()}
Strategy: ${CURRENT_STRATEGY}
Number of Runs: ${NUM_RUNS}
Samples Per Run: ${NUM_SAMPLES}
Total Samples Successfully Evaluated Across All Runs: ${totalEvaluatedSamples}

OVERALL AVERAGED METRICS:
- Mean Reciprocal Rank (MRR): ${mrr.toFixed(4)}
- Mean Rank (found docs only): ${meanRank.toFixed(2)}
- Median Rank (found docs only): ${medianRank.toFixed(2)}
- Success@3: ${(successAt3 * 100).toFixed(2)}%
- Success@5: ${(successAt5 * 100).toFixed(2)}%
- Success@10: ${(successAt10 * 100).toFixed(2)}%
- Success@${MAX_RANK_TO_CHECK}: ${(successRate * 100).toFixed(2)}%

AVERAGED DISTRIBUTION OF RANKS (Total samples: ${totalEvaluatedSamples}):
- Rank 1: ${rankDistribution["1"]} docs (${((rankDistribution["1"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 2-3: ${rankDistribution["2-3"]} docs (${((rankDistribution["2-3"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 4-5: ${rankDistribution["4-5"]} docs (${((rankDistribution["4-5"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 6-10: ${rankDistribution["6-10"]} docs (${((rankDistribution["6-10"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 11-20: ${rankDistribution["11-20"]} docs (${((rankDistribution["11-20"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 21-50: ${rankDistribution["21-50"]} docs (${((rankDistribution["21-50"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 51-100: ${rankDistribution["51-100"]} docs (${((rankDistribution["51-100"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Not Found (or >${MAX_RANK_TO_CHECK}): ${rankDistribution.not_found} docs (${((rankDistribution.not_found / totalEvaluatedSamples) * 100).toFixed(2)}%)

===========================================
AVERAGED PERFORMANCE BY SCHEMA
===========================================

`
  // Add schema-specific summaries
  Object.entries(metricsBySchema).forEach(([schema, metrics]) => {
    if (metrics.count > 0) {
      const meanSchemaRank =
        metrics.ranks.length > 0
          ? metrics.ranks.reduce((sum: number, rank: number) => sum + rank, 0) /
            metrics.ranks.length
          : 0
      const schemaMrr = metrics.mrrSum / metrics.count
      const schemaSuccessRate = metrics.successRateCount / metrics.count
      const schemaSuccessAt3 = metrics.successAt3Count / metrics.count
      const schemaSuccessAt5 = metrics.successAt5Count / metrics.count
      const schemaSuccessAt10 = metrics.successAt10Count / metrics.count

      content += `
===== ${schema.toUpperCase()} =====
Total Samples for Schema (Across All Runs): ${metrics.count}
MRR: ${schemaMrr.toFixed(4)}
Mean Rank (found docs): ${metrics.ranks.length > 0 ? meanSchemaRank.toFixed(2) : "N/A"}
Found Rate (@${MAX_RANK_TO_CHECK}): ${(schemaSuccessRate * 100).toFixed(2)}%
Success@3: ${(schemaSuccessAt3 * 100).toFixed(2)}%
Success@5: ${(schemaSuccessAt5 * 100).toFixed(2)}%
Success@10: ${(schemaSuccessAt10 * 100).toFixed(2)}%

${generatePerformanceSummary(schema, { ...metrics, successRateCount: metrics.successRateCount }, CURRENT_STRATEGY)}

`
    } else {
      content += `===== ${schema.toUpperCase()} =====\nNo successful evaluations for this schema.\n\n`
    }
  })

  content += `
===========================================
END OF REPORT
===========================================
`
  return content
}

/**
 * Generate a human-readable summary of schema performance based on metrics
 * (This function will now receive calculated metrics based on combined data)
 */
function generatePerformanceSummary(
  schema: string,
  metrics: {
    mrrSum: number
    ranks: number[] // Ranks from all runs for this schema
    successAt3Count: number
    successAt5Count: number
    successAt10Count: number
    successRateCount: number // Represents success within MAX_RANK_TO_CHECK
    count: number // Total samples for this schema
  },
  strategy: EvaluationStrategy,
): string {
  if (metrics.count === 0) return `${schema}: No data available.`

  const mrr = metrics.mrrSum / metrics.count
  const successAt3Rate = metrics.successAt3Count / metrics.count
  const successAt10Rate = metrics.successAt10Count / metrics.count
  const foundRate = metrics.successRateCount / metrics.count // Use successRateCount for found rate within threshold

  // Calculate mean rank (for found documents only)
  const meanRank =
    metrics.ranks.length > 0
      ? metrics.ranks.reduce((sum, rank) => sum + rank, 0) /
        metrics.ranks.length
      : 0

  // Performance classification thresholds (Keep as before)
  const MRR_EXCELLENT = 0.7
  const MRR_GOOD = 0.5
  const MRR_FAIR = 0.3
  const MRR_POOR = 0.1
  const SUCCESS_AT_3_EXCELLENT = 0.8
  const SUCCESS_AT_3_GOOD = 0.6
  const SUCCESS_AT_3_FAIR = 0.4
  const SUCCESS_AT_3_POOR = 0.2
  const FOUND_RATE_GOOD = 0.9
  const FOUND_RATE_FAIR = 0.7
  const FOUND_RATE_POOR = 0.5

  // Summary components
  let overallAssessment = ""
  let insights = []
  let suggestions = []

  // Assess overall performance based on MRR
  if (mrr >= MRR_EXCELLENT)
    overallAssessment = `${schema} performs excellently with strategy ${strategy}.`
  else if (mrr >= MRR_GOOD)
    overallAssessment = `${schema} performs well with strategy ${strategy}.`
  else if (mrr >= MRR_FAIR)
    overallAssessment = `${schema} performs adequately with strategy ${strategy}.`
  else if (mrr >= MRR_POOR)
    overallAssessment = `${schema} performs poorly with strategy ${strategy}.`
  else
    overallAssessment = `${schema} performs very poorly with strategy ${strategy}.`

  // Generate specific insights based on metrics
  if (foundRate < FOUND_RATE_FAIR) {
    insights.push(
      `Many (${((1 - foundRate) * 100).toFixed(0)}%) couldn't be found within top ${MAX_RANK_TO_CHECK}.`,
    )
    suggestions.push("Consider indexing improvements or query expansion.")
  }

  if (foundRate >= FOUND_RATE_GOOD && successAt3Rate < SUCCESS_AT_3_FAIR) {
    insights.push(
      `Docs often found but ranked low (mean rank: ${meanRank > 0 ? meanRank.toFixed(1) : "N/A"}).`,
    )
    suggestions.push("Review ranking configuration/boost factors.")
  }

  if (successAt3Rate >= SUCCESS_AT_3_GOOD) {
    insights.push(
      `${(successAt3Rate * 100).toFixed(0)}% appear in top 3, indicating good relevance.`,
    )
  }

  if (
    successAt3Rate < SUCCESS_AT_3_POOR &&
    successAt10Rate >= SUCCESS_AT_3_FAIR
  ) {
    insights.push(`Docs frequently appear in ranks 4-10 rather than top 3.`)
    suggestions.push("Fine-tune ranking to prioritize relevant results higher.")
  }

  // Schema-specific insights based on strategy (Keep as before)
  switch (schema) {
    case fileSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("File exact title search underperforming.")
        suggestions.push("Check title standardization/tokenization.")
      }
      break
    case mailSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("Email subject search underperforming.")
        suggestions.push("Review subject indexing/tokenization.")
      }
      break
    case mailAttachmentSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("Attachment filename search underperforming.")
        suggestions.push("Check filename processing/indexing (special chars?).")
      }
      break
    case userSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_EXCELLENT) {
        insights.push("User name search should be highly precise.")
        suggestions.push("Ensure names properly indexed with high boost.")
      }
      break
    case eventSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_GOOD) {
        insights.push("Event name search underperforming.")
        suggestions.push("Review event name indexing/boost factors.")
      }
      break
  }

  // Format the summary
  let summary = overallAssessment
  if (insights.length > 0)
    summary += "\\nInsights:\\n" + insights.map((i) => `- ${i}`).join("\\n")
  if (suggestions.length > 0)
    summary +=
      "\\nSuggestions:\\n" + suggestions.map((s) => `- ${s}`).join("\\n")

  return summary
}

/**
 * Main function to orchestrate multiple evaluation runs and report averaged results.
 */
async function mainEvaluationRunner() {
  Logger.info(
    `Starting search quality evaluation across schemas over ${NUM_RUNS} runs...`,
  )
  Logger.info(`Using strategy: ${CURRENT_STRATEGY}`)
  Logger.info(`Samples per run: ${NUM_SAMPLES}`)

  if (!(CURRENT_STRATEGY in EvaluationStrategy)) {
    Logger.error(
      `Invalid EVALUATION_STRATEGY: ${CURRENT_STRATEGY}. Must be one of ${Object.keys(EvaluationStrategy).join(", ")}`,
    )
    process.exit(1)
  }

  ensureDirectoryExists(OUTPUT_DIR) // Ensure output dir exists upfront

  const allRunMetrics: SingleRunMetrics[] = []
  let totalEvaluatedSamples = 0

  for (let i = 1; i <= NUM_RUNS; i++) {
    const runMetrics = await runSingleEvaluation(i)
    allRunMetrics.push(runMetrics)
    totalEvaluatedSamples += runMetrics.evaluatedSamples

    // Optional: Add a small delay between runs if needed
    if (i < NUM_RUNS) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS)) // Slightly longer delay between runs
    }
  }

  Logger.info(`--- All ${NUM_RUNS} Evaluation Runs Complete ---`)
  Logger.info(
    `Total samples successfully evaluated across all runs: ${totalEvaluatedSamples}`,
  )

  if (totalEvaluatedSamples === 0) {
    Logger.warn(
      "No samples were successfully processed and evaluated across all runs.",
    )
    // Optionally still run failure analysis if some debug data was collected despite no successful evaluations
    const allCollectedDebugData = allRunMetrics.flatMap(
      (run) => run.collectedDebugData,
    )
    if (allCollectedDebugData.length > 0) {
      performFailureAnalysis(allCollectedDebugData, OUTPUT_DIR)
    }
    return // Exit if no samples were evaluated
  }

  // Calculate averaged metrics based on consolidated data
  const averagedMetrics = calculateAverages(
    allRunMetrics,
    totalEvaluatedSamples,
  )

  // --- Report Averaged Metrics ---
  Logger.info(`
--- Averaged Evaluation Complete Across ${NUM_RUNS} Runs ---
Strategy: ${CURRENT_STRATEGY}
Total Samples Target Per Run: ${NUM_SAMPLES}
Total Samples Successfully Evaluated Across All Runs: ${totalEvaluatedSamples}

**Overall Averaged Mean Reciprocal Rank (MRR): ${averagedMetrics.mrr.toFixed(4)}**

Other Averaged Metrics:
Mean Rank (found documents only): ${averagedMetrics.meanRank.toFixed(2)}
Median Rank (found documents only): ${averagedMetrics.medianRank.toFixed(2)}
Success@3 (based on evaluated): ${(averagedMetrics.successAt3 * 100).toFixed(2)}%
Success@5 (based on evaluated): ${(averagedMetrics.successAt5 * 100).toFixed(2)}%
Success@10 (based on evaluated): ${(averagedMetrics.successAt10 * 100).toFixed(2)}%
Success@${MAX_RANK_TO_CHECK} (based on evaluated): ${(averagedMetrics.successRate * 100).toFixed(2)}%

Averaged Rank Distribution (based on ${totalEvaluatedSamples} samples):
  Rank 1: ${averagedMetrics.rankDistribution["1"]} docs (${((averagedMetrics.rankDistribution["1"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 2-3: ${averagedMetrics.rankDistribution["2-3"]} docs (${((averagedMetrics.rankDistribution["2-3"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 4-5: ${averagedMetrics.rankDistribution["4-5"]} docs (${((averagedMetrics.rankDistribution["4-5"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 6-10: ${averagedMetrics.rankDistribution["6-10"]} docs (${((averagedMetrics.rankDistribution["6-10"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 11-20: ${averagedMetrics.rankDistribution["11-20"]} docs (${((averagedMetrics.rankDistribution["11-20"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 21-50: ${averagedMetrics.rankDistribution["21-50"]} docs (${((averagedMetrics.rankDistribution["21-50"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 51-100: ${averagedMetrics.rankDistribution["51-100"]} docs (${((averagedMetrics.rankDistribution["51-100"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Not Found (or >${MAX_RANK_TO_CHECK}): ${averagedMetrics.rankDistribution.not_found} docs (${((averagedMetrics.rankDistribution.not_found / totalEvaluatedSamples) * 100).toFixed(2)}%)
`)

  // Report averaged metrics by schema
  Logger.info(`--- Averaged Metrics by Schema (Across ${NUM_RUNS} Runs) ---`)
  Object.entries(averagedMetrics.metricsBySchema).forEach(
    ([schema, metrics]) => {
      if (metrics.count > 0) {
        const meanSchemaRank =
          metrics.ranks.length > 0
            ? metrics.ranks.reduce((sum, rank) => sum + rank, 0) /
              metrics.ranks.length
            : 0
        const schemaMrr = metrics.mrrSum / metrics.count
        const schemaSuccessRate = metrics.successRateCount / metrics.count
        const schemaSuccessAt3 = metrics.successAt3Count / metrics.count
        const schemaSuccessAt5 = metrics.successAt5Count / metrics.count
        const schemaSuccessAt10 = metrics.successAt10Count / metrics.count

        Logger.info(`Schema: ${schema} (Total Samples: ${metrics.count})`)
        Logger.info(`  MRR: ${schemaMrr.toFixed(4)}`)
        Logger.info(
          `  Mean Rank (found docs): ${metrics.ranks.length > 0 ? meanSchemaRank.toFixed(2) : "N/A"}`,
        )
        Logger.info(
          `  Median Rank (found docs): ${metrics.ranks.length > 0 ? averagedMetrics.medianRank.toFixed(2) : "N/A"}`, // Use overall median for consistency? Or calculate per schema? Let's stick to calculating per schema median here.
        )
        // Recalculate median rank per schema from the combined ranks array
        let medianSchemaRank = 0
        if (metrics.ranks.length > 0) {
          const sortedRanks = [...metrics.ranks].sort((a, b) => a - b)
          const midIndex = Math.floor(sortedRanks.length / 2)
          medianSchemaRank =
            sortedRanks.length % 2 === 0
              ? (sortedRanks[midIndex - 1] + sortedRanks[midIndex]) / 2
              : sortedRanks[midIndex]
        }
        Logger.info(
          `  Median Rank (found docs): ${metrics.ranks.length > 0 ? medianSchemaRank.toFixed(2) : "N/A"}`,
        )

        Logger.info(
          `  Found Rate (@${MAX_RANK_TO_CHECK}): ${(schemaSuccessRate * 100).toFixed(2)}%`,
        )
        Logger.info(`  Success@3: ${(schemaSuccessAt3 * 100).toFixed(2)}%`)
        Logger.info(`  Success@5: ${(schemaSuccessAt5 * 100).toFixed(2)}%`)
        Logger.info(`  Success@10: ${(schemaSuccessAt10 * 100).toFixed(2)}%`)

        // Generate and display performance summary for averaged schema metrics
        const summary = generatePerformanceSummary(
          schema,
          metrics, // Pass the metrics for this schema (includes ranks array etc.)
          CURRENT_STRATEGY,
        )
        Logger.info("\\n  Performance Summary:")
        summary.split("\\n").forEach((line) => {
          Logger.info(`  ${line}`)
        })
        Logger.info("")
      } else {
        Logger.info(
          `Schema: ${schema} - No successful evaluations across all runs.`,
        )
        Logger.info("")
      }
    },
  )

  // --- Save Reports ---
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

    // Save consolidated detailed evaluation results (all samples from all runs)
    const allResults = allRunMetrics.flatMap((run) => run.results)
    const resultsFilename = path.join(
      OUTPUT_DIR,
      `evaluation_results_ALL_${CURRENT_STRATEGY}_${timestamp}.json`,
    )
    fs.writeFileSync(resultsFilename, JSON.stringify(allResults, null, 2))
    Logger.info(
      `Consolidated detailed evaluation results (${allResults.length} samples) saved to ${resultsFilename}`,
    )

    // Save consolidated poor rankings
    const allPoorRankings = allResults.filter(
      (r) => r.rank === null || (r.rank && r.rank > POOR_RANK_THRESHOLD),
    )
    if (allPoorRankings.length > 0) {
      const poorRankingsFilename = path.join(
        OUTPUT_DIR,
        `poor_rankings_ALL_${CURRENT_STRATEGY}_${timestamp}.json`,
      )
      fs.writeFileSync(
        poorRankingsFilename,
        JSON.stringify(allPoorRankings, null, 2),
      )
      Logger.info(
        `Consolidated poor rankings (${allPoorRankings.length} samples with rank > ${POOR_RANK_THRESHOLD} or null) saved to ${poorRankingsFilename}`,
      )
    } else {
      Logger.info(
        `No poor rankings (rank > ${POOR_RANK_THRESHOLD} or null) found across all runs.`,
      )
    }

    // Save performance summary text file
    const summaryFilename = path.join(
      OUTPUT_DIR,
      `performance_summary_AVERAGED_${CURRENT_STRATEGY}_${timestamp}.txt`,
    )
    let summaryContent = generateSummaryReportContent(
      averagedMetrics,
      totalEvaluatedSamples,
    )
    fs.writeFileSync(summaryFilename, summaryContent)
    Logger.info(
      `Averaged performance summary text report saved to ${summaryFilename}`,
    )
  } catch (error) {
    Logger.error({ error }, "Failed to save consolidated result/summary files.")
  }

  // --- Perform Failure Analysis if Debugging Enabled ---
  const allCollectedDebugData = allRunMetrics.flatMap(
    (run) => run.collectedDebugData,
  )
  performFailureAnalysis(allCollectedDebugData, OUTPUT_DIR)
}

// Start the main evaluation runner
mainEvaluationRunner().catch((error) => {
  Logger.error({ error }, "Unhandled error during main evaluation runner")
  process.exit(1)
})
