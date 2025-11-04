import type { PublicUserWorkspace } from "@/db/schema"
import {
  chatMessageSchema,
  eventSchema,
  fileSchema,
  mailAttachmentSchema,
  mailSchema,
  userSchema,
  VespaSearchResultsSchema,
  type VespaEventSearch,
  type VespaFileSearch,
  type VespaMailAttachmentSearch,
  type VespaMailSearch,
  type VespaSearchResults,
  type VespaUser,
  type VespaChatMessageSearch,
  type ScoredChunk,
  // Corrected import name for datasourceFileSchema
  dataSourceFileSchema,
  type VespaDataSourceFileSearch,
  KbItemsSchema,
  type VespaKbFileSearch,
  chatContainerSchema,
  type VespaChatContainerSearch,
} from "@xyne/vespa-ts/types"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getRelativeTime } from "@/utils"
import type { z } from "zod"
import pc from "picocolors"
import {
  getSortedScoredChunks,
  getSortedScoredImageChunks,
} from "@xyne/vespa-ts/mappers"
import type { ChunkMetadata, UserMetadataType } from "@/types"
import { querySheetChunks } from "@/lib/duckdb"
import { chunkSheetWithHeaders } from "@/sheetChunk"

// Utility function to extract header from chunks and remove headers from each chunk
const extractHeaderAndDataChunks = (
  chunks_summary:
    | (string | { chunk: string; score: number; index: number })[]
    | undefined,
  matchfeatures?: any,
): {
  chunks_summary: (string | { chunk: string; score: number; index: number })[]
  matchfeatures?: any
} => {
  if (!chunks_summary || chunks_summary.length === 0) {
    return { chunks_summary: [], matchfeatures }
  }

  // Find the header from the first chunk
  let headerChunk = ""
  if (chunks_summary.length > 0) {
    const firstChunk =
      typeof chunks_summary[0] === "string"
        ? chunks_summary[0]
        : chunks_summary[0].chunk
    const lines = firstChunk.split("\n")
    if (lines.length > 0 && lines[0].includes("\t")) {
      headerChunk = lines[0] // Extract the header line
    }
  }

  // Process all chunks: remove header from each and keep only data rows
  const processedChunks: (
    | string
    | { chunk: string; score: number; index: number }
  )[] = []
  let newMatchfeatures = matchfeatures

  // Add header as first chunk if found, using the same structure as original
  if (headerChunk) {
    if (typeof chunks_summary[0] === "string") {
      processedChunks.push(headerChunk)
    } else {
      processedChunks.push({
        chunk: headerChunk,
        score: 1,
        index: 0,
      })
    }

    // Update matchfeatures to include the header chunk score
    if (newMatchfeatures) {
      const existingCells = newMatchfeatures.chunk_scores?.cells || {}
      const scores = Object.values(existingCells) as number[]
      const maxScore = scores.length > 0 ? Math.max(...scores) : 0
      // Create new chunk_scores that match the new chunks
      const newChunkScores: Record<string, number> = {}
      newChunkScores["0"] = maxScore + 1
      Object.entries(existingCells).forEach(([idx, score]) => {
        newChunkScores[(parseInt(idx) + 1).toString()] = score as number
      })

      newMatchfeatures = {
        ...newMatchfeatures,
        chunk_scores: {
          cells: newChunkScores,
        },
      }
    }
  }

  // Process each original chunk: remove header and add data rows
  for (let i = 0; i < chunks_summary.length; i++) {
    const originalChunk = chunks_summary[i]
    const chunkContent =
      typeof originalChunk === "string" ? originalChunk : originalChunk.chunk
    const lines = chunkContent.split("\n")

    // Skip the first line (header) and keep only data rows
    const dataRows = lines.slice(1).filter((line) => line.trim().length > 0)
    if (dataRows.length > 0) {
      const dataContent = dataRows.join("\n")

      if (typeof originalChunk === "string") {
        processedChunks.push(dataContent)
      } else {
        processedChunks.push({
          chunk: dataContent,
          score: originalChunk.score,
          index: originalChunk.index,
        })
      }
    }
  }

  return { chunks_summary: processedChunks, matchfeatures: newMatchfeatures }
}

const aggregateTableChunksForPdf = (
  chunks_summary:
  | (string | { chunk: string; score: number; index: number })[]
  | undefined,
  chunks_map: 
  | ChunkMetadata[]
  | undefined,
  matchfeatures?: any,
  ): {
    chunks_summary: (string | { chunk: string; score: number; index: number })[]
    matchfeatures: any
  } => {
  if (!chunks_summary || !chunks_map || chunks_summary.length === 0) {
    return { chunks_summary: chunks_summary || [], matchfeatures: matchfeatures }
  }

  if (chunks_summary.length !== chunks_map.length) {
    console.warn('chunks_summary and chunks_map length mismatch; skipping table aggregation')
    return { chunks_summary: chunks_summary || [], matchfeatures: matchfeatures }
  }

  // Find all chunks that have 'table' in their block_labels
  const tableChunkIndices = new Set<number>()
  chunks_map.forEach((metadata, index) => {
    if (metadata.block_labels?.includes('table')) {
      tableChunkIndices.add(index)
    }
  })

  if (tableChunkIndices.size === 0) {
    return { chunks_summary: chunks_summary || [], matchfeatures: matchfeatures }
  }

  // Group consecutive table chunks
  const tableGroups: number[][] = []
  let currentGroup: number[] = []
  let lastTableIndex = -1

  for (let i = 0; i < chunks_summary.length; i++) {
    if (tableChunkIndices.has(i)) {
      if (lastTableIndex === -1 || i === lastTableIndex + 1) {
        // First table chunk or consecutive table chunk
        currentGroup.push(i)
      } else {
        // Non-consecutive table chunk, start new group
        if (currentGroup.length > 0) {
          tableGroups.push([...currentGroup])
        }
        currentGroup = [i]
      }
      lastTableIndex = i
    } else {
      // Non-table chunk, end current group if exists
      if (currentGroup.length > 0) {
        tableGroups.push([...currentGroup])
        currentGroup = []
      }
      lastTableIndex = -1
    }
  }

  // Add the last group if it exists
  if (currentGroup.length > 0) {
    tableGroups.push(currentGroup)
  }

  // Process each table group
  const processedChunks: (string | { chunk: string; score: number; index: number })[] = chunks_summary || []
  const existingCells = matchfeatures?.chunk_scores?.cells || {}
  const newChunkScores: Record<string, number> = {}
  Object.entries(existingCells).forEach(([idx, score]) => {
    newChunkScores[parseInt(idx).toString()] = score as number
  })
  
  // Process each table group
  tableGroups.forEach((group) => {
    if (group.length === 0) return

    // Get scores for chunks in this group from matchfeatures
    const groupScores: { index: number; score: number }[] = []
    
    if (matchfeatures?.chunk_scores?.cells) {
      group.forEach((chunkIndex) => {
        const score = matchfeatures.chunk_scores.cells[chunkIndex.toString()] || 0
        groupScores.push({ index: chunkIndex, score })
      })
    } else {
      // If no matchfeatures, use chunk scores from chunks_summary
      group.forEach((chunkIndex) => {
        const chunk = chunks_summary[chunkIndex]
        const score = typeof chunk === 'string' ? 0 : chunk.score
        groupScores.push({ index: chunkIndex, score })
      })
    }

    // Find the chunk with the highest score
    const highestScoreChunk = groupScores.reduce((max, current) => 
      current.score > max.score ? current : max
    )

    // Concatenate all chunks in the group
    const concatenatedContent = group
      .map((chunkIndex) => {
        const chunk = chunks_summary[chunkIndex]
        return typeof chunk === 'string' ? chunk : chunk.chunk
      })
      .join('\n')

    // Clear out all chunks in this group except the highest scoring one
    group.forEach((chunkIndex) => {
      if (chunkIndex !== highestScoreChunk.index) {
        processedChunks[chunkIndex] = typeof processedChunks[chunkIndex] === 'string' ? "" : {
          chunk: "",
          score: 0,
          index: chunkIndex,
        }
        newChunkScores[chunkIndex.toString()] = 0
      }
    })

    // Create the merged chunk using the highest scoring chunk's structure
    const originalChunk = chunks_summary[highestScoreChunk.index]
    const mergedChunk = typeof originalChunk === 'string' 
      ? concatenatedContent
      : {
          chunk: concatenatedContent,
          score: highestScoreChunk.score,
          index: highestScoreChunk.index,
        }

    processedChunks[highestScoreChunk.index] = mergedChunk
    newChunkScores[highestScoreChunk.index.toString()] = highestScoreChunk.score
  })

  const newMatchfeatures = {
    ...matchfeatures,
    chunk_scores: {
      cells: newChunkScores,
    },
  }

  return {
    chunks_summary: processedChunks,
    matchfeatures: newMatchfeatures,
  }
}

// Utility function to process sheet queries for spreadsheet files
const processSheetQuery = async (
  chunks_summary:
    | (string | { chunk: string; score: number; index: number })[]
    | undefined,
  query: string,
  matchfeatures: any,
): Promise<{
  chunks_summary: { chunk: string; score: number; index: number }[]
  matchfeatures: any
  maxSummaryChunks: number
} | null> => {
  const duckDBResult = await querySheetChunks(
    chunks_summary?.map((c) => (typeof c === "string" ? c : c.chunk)) || [],
    query,
  )

  // If DuckDB query failed (null means not metric-related or SQL generation failed), return null to fallback to original approach
  if (!duckDBResult) {
    return null
  }

  // Create metadata chunk with query information (excluding data)
  const metadataChunk = JSON.stringify(
    {
      assumptions: duckDBResult.assumptions,
      schema_fragment: duckDBResult.schema_fragment,
    },
    null,
    2,
  )

  // Use chunkSheetWithHeaders to chunk the 2D array data
  const dataChunks = chunkSheetWithHeaders(duckDBResult.data.rows, {
    headerRows: 1,
  })

  // Combine metadata chunk with data chunks
  const allChunks = [metadataChunk, ...dataChunks]

  const newChunksSummary = allChunks.map((c, idx) => ({
    chunk: c,
    score: 0,
    index: idx,
  }))

  // Update matchfeatures to correspond to the new chunks
  let newMatchfeatures = matchfeatures
  if (matchfeatures) {
    // Create new chunk_scores that match the new chunks
    const newChunkScores: Record<string, number> = {}
    allChunks.forEach((_, idx) => {
      newChunkScores[idx.toString()] = 0 // All new chunks get score 0
    })

    // Update the matchfeatures with new chunk_scores
    newMatchfeatures = {
      ...matchfeatures,
      chunk_scores: {
        cells: newChunkScores,
      },
    }
  }

  return {
    chunks_summary: newChunksSummary,
    matchfeatures: newMatchfeatures,
    maxSummaryChunks: allChunks.length,
  }
}

// Utility to capitalize the first letter of a string
const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

export const constructToolContext = (
  tool_schema: string,
  toolName: string,
  description: string,
) => {
  const tool = JSON.parse(tool_schema)
  const toolSchemaContext = Object.entries(tool).map(
    ([key, value]) => `- ${key}: ${JSON.stringify(value)}`,
  )
  return `
Tool Name: ${toolName}
Tool Description: ${description}
  Tool Schema:
   ${toolSchemaContext.join("\n")}
   `
}

// Function for handling file context
const constructFileContext = (
  fields: VespaFileSearch,
  userTimezone: string,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }
  // Handle metadata that might already be an object or a string that needs parsing
  const parsedMetadata =
    typeof fields.metadata === "string"
      ? JSON.parse(fields.metadata)
      : fields.metadata
  const folderName = parsedMetadata.parents?.[0]?.folderName || ""
  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)} (${new Date(fields.createdAt).toLocaleString("en-US", { timeZone: userTimezone })})` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)} (${new Date(fields.updatedAt).toLocaleString("en-US", { timeZone: userTimezone })})` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.parentId ? `parent FolderId: ${fields.parentId}` : ""}
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.metadata ? `parent FolderName: ${folderName}` : ""} 
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}`
}

// TODO: tell if workspace that this is an employee
const constructUserContext = (fields: VespaUser): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\nAdded: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `Name: ${fields.name}` : ""}
${fields.email ? `Email: ${fields.email}` : ""}
${fields.gender ? `Gender: ${fields.gender}` : ""}
${fields.orgJobTitle ? `Job Title: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `Department: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `Location: ${fields.orgLocation}` : ""}`
}

const constructMailContext = (
  fields: VespaMailSearch,
  userTimezone: string,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\nSent: ${getRelativeTime(fields.timestamp)}  (${new Date(fields.timestamp).toLocaleString("en-US", { timeZone: userTimezone })})` : ""}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Labels: ${fields.labels.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}`
}

const constructSlackMessageContext = (
  fields: VespaChatMessageSearch,
  userTimezone: string,
): string => {
  let channelCtx = ``
  if (fields.isIm && fields.permissions) {
    channelCtx = `It's a DM between ${fields.permissions.join(", ")}`
  } else if (!fields.isPrivate) {
    // mpim and public channel
    channelCtx = `It's a message in ${fields.channelName}`
  } else {
    channelCtx = `It's a in private channel ${fields.channelName}`
  }
  return `${channelCtx}
    App: ${fields.app}
    Entity: ${fields.entity}
    User: ${fields.name}
    Username: ${fields.username}
    Message: ${fields.text}
    ${fields.threadId ? "it's a message thread" : ""}
    ${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\n    Time: ${getRelativeTime(fields.createdAt)} (${new Date(fields.createdAt).toLocaleString("en-US", { timeZone: userTimezone })})` : ""}
    User is part of Workspace: ${fields.teamName}`
}

const constructSlackChannelContext = (
  fields: VespaChatContainerSearch,
  userTimezone: string,
): string => {
  let channelCtx = ``
  if (fields.isIm) {
    channelCtx = `It's a DM.`
  } else if (fields.isMpim) {
    channelCtx = `It's a group DM.`
  } else if (fields.isPrivate) {
    channelCtx = `It's a private channel.`
  } else {
    channelCtx = `It's a public channel.`
  }

  return `${channelCtx}
App: ${fields.app}
Entity: ${fields.entity ?? "channel"}
Name: ${fields.name}
${fields.topic ? `Topic: ${fields.topic}` : ""}
${fields.description ? `Description: ${fields.description}` : ""}
${fields.permissions ? `Users in channel: ${fields.permissions.join(", ")}` : ""}
${
  typeof fields.createdAt === "number" && isFinite(fields.createdAt)
    ? `\nCreated: ${getRelativeTime(fields.createdAt)} (${new Date(
        fields.createdAt,
      ).toLocaleString("en-US", { timeZone: userTimezone })})`
    : ""
}`
}

const constructMailAttachmentContext = (
  fields: VespaMailAttachmentSearch,
  userTimeZone: string,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}
${
  typeof fields.timestamp === "number" && isFinite(fields.timestamp)
    ? `\nSent: ${getRelativeTime(fields.timestamp)} (${new Date(fields.timestamp).toLocaleString("en-US", { timeZone: userTimeZone })})`
    : ""
}
${fields.filename ? `Filename: ${fields.filename}` : ""}
${fields.partId ? `Attachment_no: ${fields.partId}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}`
}

const constructEventContext = (
  fields: VespaEventSearch,
  dateForAI: string,
  userTimeZone: string,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Event Name: ${fields.name ? `Name: ${fields.name}` : ""}
Description: ${fields.description ? fields.description.substring(0, 50) : ""}
Base URL: ${fields.baseUrl ? fields.baseUrl : "No base URL"}
Status: ${fields.status ? fields.status : "Status unknown"}
Location: ${fields.location ? fields.location : "No location specified"}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated: ${getRelativeTime(fields.updatedAt)}` : ""}
Today's Date: ${dateForAI}
${
  typeof fields.startTime === "number" && isFinite(fields.startTime)
    ? `\nStart Time: ${
        !fields.defaultStartTime
          ? new Date(fields.startTime).toUTCString() +
            `(${new Date(fields.startTime).toLocaleString("en-US", { timeZone: userTimeZone })})`
          : `No start time specified but date is ${new Date(fields.startTime)}`
      }`
    : ""
}
${
  typeof fields.endTime === "number" && isFinite(fields.endTime)
    ? `\nEnd Time: ${
        !fields.defaultStartTime
          ? new Date(fields.endTime).toUTCString() +
            `(${new Date(fields.endTime).toLocaleString("en-US", { timeZone: userTimeZone })})`
          : `No end time specified but date is ${new Date(fields.endTime)}`
      }`
    : ""
}
Organizer: ${fields.organizer ? fields.organizer.displayName : "No organizer specified"}
Attendees: ${
    fields.attendees && fields.attendees.length
      ? fields.attendees
          .map((attendee) => `${attendee.email} ${attendee.displayName}`)
          .join(", ")
      : "No attendees listed"
  }
Recurrence: ${
    fields.recurrence && fields.recurrence.length
      ? fields.recurrence.join(", ")
      : "No recurrence pattern specified"
  }
Joining Link: ${fields.joiningLink ? fields.joiningLink : "No meeting link available"}
Cancelled Instances: ${
    fields.cancelledInstances && fields.cancelledInstances.length
      ? fields.cancelledInstances.join(", ")
      : "No cancelled instances"
  }
`
}

// Function for handling file context
const constructFileMetadataContext = (fields: VespaFileSearch): string => {
  const parsedMetadata =
    typeof fields.metadata === "string"
      ? JSON.parse(fields.metadata)
      : fields.metadata
  const folderName = parsedMetadata.parents?.[0]?.folderName || ""

  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.parentId ? `Parent FolderId: ${fields.parentId}` : ""}
${fields.metadata ? `parent FolderName: ${folderName}` : ""} 
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}`
}

// TODO: tell if workspace that this is an employee
const constructUserMetadataContext = (fields: VespaUser): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\nAdded: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `Name: ${fields.name}` : ""}
${fields.email ? `Email: ${fields.email}` : ""}
${fields.gender ? `Gender: ${fields.gender}` : ""}
${fields.orgJobTitle ? `Job Title: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `Department: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `Location: ${fields.orgLocation}` : ""}`
}

const constructMailMetadataContext = (fields: VespaMailSearch): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\nSent: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Mailbox Labels: ${fields.labels.join(", ")}` : ""}`
}

const constructMailAttachmentMetadataContext = (
  fields: VespaMailAttachmentSearch,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\ntimestamp: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.partId ? `Attachment_no: ${fields.partId}` : ""}
${fields.filename ? `Filename: ${fields.filename}` : ""}
${fields.fileType ? `FileType: ${fields.fileType}` : ""}`
}

const constructFileColoredContext = (fields: VespaFileSearch): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}
${fields.title ? `${pc.green("Title")}: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\n${pc.green("Created")}: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\n${pc.green("Updated At")}: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.url ? `${pc.green("Link")}: ${pc.cyan(fields.url)}` : ""}
${fields.owner ? `${pc.green("Owner")}: ${fields.owner}` : ""}
${fields.ownerEmail ? `${pc.green("Owner Email")}: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `${pc.green("Mime Type")}: ${fields.mimeType}` : ""}
${fields.permissions ? `${pc.green("Permissions")}: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `${pc.green("Content")}: ${fields.chunks_summary.join("\n")}` : ""}`
}

const constructUserColoredContext = (fields: VespaUser): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\n${pc.green("Added")}: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `${pc.green("Name")}: ${fields.name}` : ""}
${fields.email ? `${pc.green("Email")}: ${fields.email}` : ""}
${fields.gender ? `${pc.green("Gender")}: ${fields.gender}` : ""}
${fields.orgJobTitle ? `${pc.green("Job Title")}: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `${pc.green("Department")}: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `${pc.green("Location")}: ${fields.orgLocation}` : ""}`
}

const constructMailColoredContext = (fields: VespaMailSearch): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\n${pc.green("Sent")}: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.subject ? `${pc.green("Subject")}: ${fields.subject}` : ""}
${fields.from ? `${pc.green("From")}: ${fields.from}` : ""}
${fields.to ? `${pc.green("To")}: ${fields.to.join(", ")}` : ""}
${fields.cc ? `${pc.green("Cc")}: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `${pc.green("Bcc")}: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `${pc.green("Labels")}: ${fields.labels.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `${pc.green("Content")}: ${fields.chunks_summary.join("\n")}` : ""}`
}

const constructDataSourceFileContext = (
  fields: VespaDataSourceFileSearch,
  userTimeZone: string,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures && fields.chunks_summary) {
    const summaryStrings = fields.chunks_summary.map((c) =>
      typeof c === "string" ? c : c.chunk,
    )
    chunks = getSortedScoredChunks(fields.matchfeatures, summaryStrings)
  } else if (fields.chunks_summary) {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: typeof chunk === "string" ? 0 : chunk.score,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  let imageChunks: ScoredChunk[] = []
  const maxImageChunks =
    fields.image_chunks_summary?.length &&
    fields.image_chunks_summary?.length < 5
      ? fields.image_chunks_summary?.length
      : 5
  if (fields.matchfeatures) {
    imageChunks = getSortedScoredImageChunks(
      fields.matchfeatures,
      fields.image_chunks_pos_summary as number[],
      fields.image_chunks_summary as string[],
      fields.docId,
    )
  } else {
    const imageChunksPos = fields.image_chunks_pos_summary as number[]
    imageChunks =
      fields.image_chunks_summary?.map((chunk, idx) => ({
        chunk: `${fields.docId}_${imageChunksPos[idx]}`,
        index: idx,
        score: 0,
      })) || []
  }

  let imageContent = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    imageContent = imageChunks
      .slice(0, maxImageChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    imageContent = imageChunks.map((v) => v.chunk).join("\n")
  } else {
    imageContent = imageChunks
      .slice(0, maxImageChunks)
      .map((v) => v.chunk)
      .join("\n")
  }

  return `Title: ${fields.fileName || "N/A"}
  App: ${fields.app || "N/A"}
  ${fields.dataSourceName ? `Data Source Name: ${fields.dataSourceName}` : ""}
  Mime Type: ${fields.mimeType || "N/A"}
  ${fields.fileSize ? `File Size: ${fields.fileSize} bytes` : ""}
  ${
    typeof fields.createdAt === "number" && isFinite(fields.createdAt)
      ? `\nCreated: ${getRelativeTime(fields.createdAt)} (${new Date(fields.createdAt).toLocaleString("en-US", { timeZone: userTimeZone })})`
      : ""
  }
  ${
    typeof fields.updatedAt === "number" && isFinite(fields.updatedAt)
      ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)} (${new Date(fields.updatedAt).toLocaleString("en-US", { timeZone: userTimeZone })})`
      : ""
  }
  ${fields.uploadedBy ? `Uploaded By: ${fields.uploadedBy}` : ""}
  ${content ? `Content: ${content}` : ""}
  ${fields.image_chunks_summary && fields.image_chunks_summary.length ? `Image File Names: ${imageContent}` : ""}`
}

const constructCollectionFileContext = (
  fields: VespaKbFileSearch,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
  isMsgWithKbItems?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }
  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures && fields.chunks_summary) {
    const summaryStrings = fields.chunks_summary.map((c) =>
      typeof c === "string" ? c : c.chunk,
    )
    if (!maxSummaryChunks) {
      maxSummaryChunks = 10
    }
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      summaryStrings,
      maxSummaryChunks,
    )
  } else if (fields.chunks_summary) {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: typeof chunk === "string" ? 0 : chunk.score,
      })) || []
  }

  let content = ""
  if (isMsgWithKbItems && fields.chunks_pos_summary) {
    content = chunks
      .map((v) => {
        const originalIndex = fields.chunks_pos_summary?.[v.index] ?? v.index
        return `[${originalIndex}] ${v.chunk}`
      })
      .slice(0, maxSummaryChunks)
      .join("\n")
  } else if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  let imageChunks: ScoredChunk[] = []
  const maxImageChunks =
    fields.image_chunks_summary?.length &&
    fields.image_chunks_summary?.length < 5
      ? fields.image_chunks_summary?.length
      : 5

  if (fields.matchfeatures) {
    const summaryStrings =
      fields.image_chunks_summary?.map((c) =>
        typeof c === "string" ? c : c.chunk,
      ) || []

    imageChunks = getSortedScoredImageChunks(
      fields.matchfeatures,
      fields.image_chunks_pos_summary as number[],
      summaryStrings as string[],
      fields.docId,
    )
  } else {
    const imageChunksPos = fields.image_chunks_pos_summary as number[]

    imageChunks =
      fields.image_chunks_summary?.map((chunk, idx) => {
        const result = {
          chunk: `${fields.docId}_${imageChunksPos[idx]}`,
          index: idx,
          score: 0,
        }
        return result
      }) || []
  }

  let imageContent = imageChunks
    .slice(0, maxImageChunks)
    .map((v) => v.chunk)
    .join("\n")

  return `Source: Knowledge Base
File: ${fields.fileName || "N/A"}
Knowledge Base ID: ${fields.clId || "N/A"}
Mime Type: ${fields.mimeType || "N/A"}
${fields.fileSize ? `File Size: ${fields.fileSize} bytes` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.createdBy ? `Uploaded By: ${fields.createdBy}` : ""}
${content ? `Content: ${content}` : ""}
${fields.image_chunks_summary && fields.image_chunks_summary.length ? `Image File Names: ${imageContent}` : ""}`
}

type AiMetadataContext = string
export const answerMetadataContextMap = (
  searchResult: VespaSearchResults,
  dateForAI: string,
  userTimeZone: string,
): AiMetadataContext => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileMetadataContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserMetadataContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailMetadataContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === mailAttachmentSchema) {
    return constructMailAttachmentMetadataContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === eventSchema) {
    return constructEventContext(searchResult.fields, dateForAI, userTimeZone)
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

export const answerColoredContextMap = (
  searchResult: VespaSearchResults,
): string => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileColoredContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserColoredContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailColoredContext(searchResult.fields)
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

type AiContext = string
export const answerContextMap = async (
  searchResult: VespaSearchResults,
  userMetadata: UserMetadataType,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
  isMsgWithKbItems?: boolean,
  query?: string,
): Promise<AiContext> => {
  if (
    searchResult.fields.sddocname === fileSchema ||
    searchResult.fields.sddocname === dataSourceFileSchema ||
    searchResult.fields.sddocname === KbItemsSchema ||
    searchResult.fields.sddocname === mailAttachmentSchema
  ) {
    let mimeType
    if (searchResult.fields.sddocname === mailAttachmentSchema) {
      mimeType = searchResult.fields.fileType
    } else {
      mimeType = searchResult.fields.mimeType
    }
    if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel" ||
      mimeType === "text/csv"
    ) {
      const result = extractHeaderAndDataChunks(
        searchResult.fields.chunks_summary,
        searchResult.fields.matchfeatures,
      )
      searchResult.fields.chunks_summary = result.chunks_summary
      if (result.matchfeatures) {
        searchResult.fields.matchfeatures = result.matchfeatures
      }

      if (query) {
        const sheetResult = await processSheetQuery(
          searchResult.fields.chunks_summary,
          query,
          searchResult.fields.matchfeatures,
        )
        if (sheetResult) {
          const {
            chunks_summary,
            matchfeatures,
            maxSummaryChunks: newMaxSummaryChunks,
          } = sheetResult
          searchResult.fields.chunks_summary = chunks_summary
          searchResult.fields.matchfeatures = matchfeatures
          maxSummaryChunks = newMaxSummaryChunks
        } else {
          maxSummaryChunks = Math.min(
            searchResult.fields.chunks_summary?.length || 0,
            100,
          )
        }
      }
    } else if (mimeType === "application/pdf") {
      const result = aggregateTableChunksForPdf(
        searchResult.fields.chunks_summary,
        (searchResult.fields as any).chunks_map,
        searchResult.fields.matchfeatures,
      )
      searchResult.fields.chunks_summary = result.chunks_summary
      if (result.matchfeatures) {
        searchResult.fields.matchfeatures = result.matchfeatures
      }
    }
  }
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileContext(
      searchResult.fields,
      userMetadata.userTimezone,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailContext(
      searchResult.fields,
      userMetadata.userTimezone,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === eventSchema) {
    return constructEventContext(
      searchResult.fields,
      userMetadata.dateForAI,
      userMetadata.userTimezone,
    )
  } else if (searchResult.fields.sddocname === mailAttachmentSchema) {
    return constructMailAttachmentContext(
      searchResult.fields,
      userMetadata.userTimezone,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === chatMessageSchema) {
    return constructSlackMessageContext(
      searchResult.fields,
      userMetadata.userTimezone,
    )
  } else if (searchResult.fields.sddocname === chatContainerSchema) {
    return constructSlackChannelContext(
      searchResult.fields,
      userMetadata.userTimezone,
    )
  } else if (searchResult.fields.sddocname === dataSourceFileSchema) {
    return constructDataSourceFileContext(
      searchResult.fields as VespaDataSourceFileSearch,
      userMetadata.userTimezone,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === KbItemsSchema) {
    return constructCollectionFileContext(
      searchResult.fields as VespaKbFileSearch,
      maxSummaryChunks,
      isSelectedFiles,
      isMsgWithKbItems,
    )
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

// New function to handle MinimalAgentFragment arrays
export const answerContextMapFromFragments = (
  fragments: MinimalAgentFragment[],
  maxSummaryChunks?: number,
): string => {
  if (!fragments || fragments.length === 0) {
    return ""
  }

  return fragments
    .map((fragment, index) => {
      const citationIndex = index + 1
      return `[index ${citationIndex}] ${fragment.content}`
    })
    .join("\n\n")
}

export const cleanContext = (text: string): string => {
  return cleanDocs(cleanVespaHighlights(text))
}

export const cleanColoredContext = (text: string): string => {
  return cleanColoredDocs(cleanVespaHighlights(text))
}

const cleanVespaHighlights = (text: string): string => {
  if (!text) return ""
  const hiTagPattern = /<\/?hi>/g
  return text.replace(hiTagPattern, "").trim()
}
const cleanColoredDocs = (text: string): string => {
  const urlPattern =
    /!\[.*?\]\(https:\/\/lh7-rt\.googleusercontent\.com\/docsz\/[a-zA-Z0-9-_?=&]+\)/g
  let cleanedText = text.replace(urlPattern, "")

  // ........
  const extendedEllipsisPattern = /[…\.\s]{2,}/g
  cleanedText = cleanedText.replace(extendedEllipsisPattern, " ")
  // .0.0.0.0.0.0.0.0
  const repetitiveDotZeroPattern = /(?:\.0)+(\.\d+)?/g
  cleanedText = cleanedText.replace(repetitiveDotZeroPattern, "")

  // Remove control characters
  // Adjusted control characters pattern to exclude ANSI escape codes (\x1B)
  const controlCharsPattern = /[\x00-\x08\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText
}

// google docs need lots of cleanup
export const cleanDocs = (text: string): string => {
  const urlPattern =
    /!\[.*?\]\(https:\/\/lh7-rt\.googleusercontent\.com\/docsz\/[a-zA-Z0-9-_?=&]+\)/g
  let cleanedText = text.replace(urlPattern, "")

  // Handle newlines first
  cleanedText = cleanedText.replace(/\s+/g, " ")

  // ........
  const extendedEllipsisPattern = /[…\.]{2,}/g
  cleanedText = cleanedText.replace(extendedEllipsisPattern, " ")

  // .0.0.0.0.0.0.0.0 while retaining the numeric
  const repetitiveDotZeroPattern = /(?<!\d)\s*[.0]+\.0(?:\.0)+\s*/g

  cleanedText = cleanedText.replace(repetitiveDotZeroPattern, " ")

  // Remove control characters
  const controlCharsPattern = /[\x00-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText.trim()
}

// TODO:
// inform about the location
// tell the IP of the user as well
export const userContext = ({
  user,
  workspace,
}: PublicUserWorkspace): string => {
  const now = new Date()
  const userTimeZone = user?.timeZone || "Asia/Kolkata"
  const currentDate = now.toLocaleDateString("en-US", {
    timeZone: userTimeZone,
  }) // e.g., "11/10/2024"
  const currentTime = now.toLocaleTimeString("en-US", {
    timeZone: userTimeZone,
  }) // e.g., "10:14:03 AM"
  return `My Name is ${user.name}
    Email: ${user.email}
    Company: ${workspace.name}
    Company domain: ${workspace.domain}
    Current Time: ${currentTime}
    Today is: ${currentDate}
    Timezone: ${userTimeZone}`
}

/**
 * Matches URLs starting with 'http://' or 'https://'.
 */
const URL_REGEX: RegExp = /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi
/**
 * Replaces URLs in the given text with placeholders in the format '[link: domain.tld]'.
 *
 * @param text - The text in which to replace URLs.
 * @returns The text with URLs replaced by placeholders.
 */
export const replaceLinks = (text: string): string => {
  return text.replace(URL_REGEX, (match: string): string => {
    try {
      const parsedUrl: URL = new URL(match)
      const domain: string = parsedUrl.hostname
      return `${domain}`
    } catch (e) {
      // If URL parsing fails, return the original match
      return match
    }
  })
}
