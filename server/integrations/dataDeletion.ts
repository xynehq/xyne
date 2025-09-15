import VespaClient from "@xyne/vespa-ts/client"
import { GetDocument, UpdateDocument, DeleteDocument } from "@/search/vespa"
import type { VespaSearchResponse, VespaSchema } from "@xyne/vespa-ts/types"
import {
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  mailAttachmentSchema,
} from "@xyne/vespa-ts/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "dataDeletion",
})
const vespaClient = new VespaClient()

// Define service to schema mapping
// This will help in targeting specific schemas based on service names
const serviceSchemaMapping: Record<
  string,
  { schema: VespaSchema; timestampField?: string }
> = {
  drive: { schema: fileSchema, timestampField: "updatedAt" },
  gmail: { schema: mailSchema, timestampField: "timestamp" },
  calendar: { schema: eventSchema, timestampField: "startTime" },
  attachments: { schema: mailAttachmentSchema, timestampField: "timestamp" },
  // 'user' data might be handled differently (e.g., direct deletion without date range)
  userProfile: { schema: userSchema, timestampField: "creationTime" },
}

async function getVespaDocumentCount(yqlQuery: string): Promise<number> {
  try {
    const countPayload = {
      yql: yqlQuery,
      hits: 0,
      "ranking.profile": "unranked",
    }
    const searchResult: VespaSearchResponse =
      await vespaClient.search(countPayload)
    return searchResult.root?.fields?.totalCount || 0
  } catch (error) {
    Logger.error({ error, yqlQuery }, "Error getting Vespa document count")
    return 0
  }
}

async function processPermissionUpdatesAndDeleteIfSoleOwner(
  bareSchemaName: VespaSchema,
  permissionQueryWithDateFilter: string,
  emailToRemove: string,
  deleteOnlyIfSoleOwner: boolean = true, // Added flag
): Promise<{ updatedCount: number; deletedCount: number }> {
  Logger.info(
    { bareSchemaName, emailToRemove, permissionQueryWithDateFilter },
    "[Permissions] Processing schema for email",
  )

  const lowercasedEmailToRemove = emailToRemove.toLowerCase()
  let offset = 0
  let hasMore = true
  const BATCH_SIZE = 50
  let processedCount = 0
  let deletedCount = 0
  let updatedCount = 0

  while (hasMore) {
    const searchPayload = {
      yql: permissionQueryWithDateFilter,
      hits: BATCH_SIZE,
      // offset: offset,
      // due to this we were missing documents in next search
      // previous docs won't be there in next search as permission is updated
      timeout: "10s",
      "ranking.profile": "unranked",
    }

    Logger.debug(
      { searchPayload },
      `[Permissions] Fetching batch for ${bareSchemaName}`,
    )
    const searchResult: VespaSearchResponse =
      await vespaClient.search(searchPayload)
    const docsToProcess = searchResult.root?.children || []
    Logger.debug(
      `[Permissions] Fetched ${docsToProcess.length} documents in this batch for ${bareSchemaName}.`,
    )

    if (docsToProcess.length === 0) {
      hasMore = false
      break
    }

    processedCount += docsToProcess.length

    for (const doc of docsToProcess) {
      if (
        !doc.fields ||
        !("docId" in doc.fields) ||
        !("permissions" in doc.fields)
      ) {
        Logger.warn(
          {
            docId: (doc.fields as any)?.docId,
            vespaId: doc.id,
            schema: bareSchemaName,
            fields: doc.fields,
          },
          "[Permissions] Skipping document due to missing docId or permissions field.",
        )
        continue
      }
      const docFields = doc.fields as { docId: string; permissions: string[] }
      const docIdToProcess = docFields.docId
      const currentPermissions = Array.isArray(docFields.permissions)
        ? docFields.permissions
        : []

      Logger.debug(
        {
          docIdToProcess,
          vespaId: doc.id,
          schema: bareSchemaName,
          currentPermissions,
          emailToRemove,
        },
        "[Permissions] Processing document",
      )

      const emailExistsInPermissions = currentPermissions.some(
        (p) => p.toLowerCase() === lowercasedEmailToRemove,
      )

      if (emailExistsInPermissions) {
        const updatedPermissions = currentPermissions.filter(
          (p) => p.toLowerCase() !== lowercasedEmailToRemove,
        )
        Logger.info(
          {
            docIdToProcess,
            schema: bareSchemaName,
            originalPermissions: currentPermissions,
            updatedPermissions,
          },
          `[Permissions] Email ${emailToRemove} found. Permissions will be updated.`,
        )

        if (deleteOnlyIfSoleOwner && updatedPermissions.length === 0) {
          Logger.info(
            { docIdToProcess, schema: bareSchemaName },
            `[Permissions] Email ${emailToRemove} was the last permission holder. Attempting to delete document.`,
          )
          try {
            await DeleteDocument(docIdToProcess, bareSchemaName)
            Logger.info(
              { docIdToProcess, schema: bareSchemaName },
              "[Permissions] Successfully requested deletion.",
            )
            deletedCount++
          } catch (error) {
            Logger.error(
              { error, docIdToProcess, schema: bareSchemaName },
              "[Permissions] Error deleting document",
            )
          }
        } else if (!deleteOnlyIfSoleOwner) {
          // If not sole owner, or if we are deleting regardless of other permissions
          Logger.info(
            { docIdToProcess, schema: bareSchemaName },
            `[Permissions] Flag deleteOnlyIfSoleOwner is false, or other permissions exist. Attempting to delete document directly.`,
          )
          try {
            await DeleteDocument(docIdToProcess, bareSchemaName)
            Logger.info(
              { docIdToProcess, schema: bareSchemaName },
              "[Permissions] Successfully requested deletion (direct).",
            )
            deletedCount++
          } catch (error) {
            Logger.error(
              { error, docIdToProcess, schema: bareSchemaName },
              "[Permissions] Error deleting document (direct)",
            )
          }
        } else {
          // Has other permissions and deleteOnlyIfSoleOwner is true
          Logger.info(
            { docIdToProcess, schema: bareSchemaName, updatedPermissions },
            `[Permissions] Others remain. Attempting to update permissions.`,
          )
          try {
            await UpdateDocument(bareSchemaName, docIdToProcess, {
              permissions: updatedPermissions,
            })
            Logger.info(
              { docIdToProcess, schema: bareSchemaName },
              "[Permissions] Successfully requested permission update.",
            )
            updatedCount++
          } catch (error) {
            Logger.error(
              {
                error,
                docIdToProcess,
                schema: bareSchemaName,
                updatedPermissions,
              },
              "[Permissions] Error updating permissions",
            )
          }
        }
      } else {
        Logger.warn(
          {
            docIdToProcess,
            schema: bareSchemaName,
            currentPermissions,
            emailToRemove,
            permissionQueryWithDateFilter,
          },
          "[Permissions] Document fetched, but email not in its permissions. This might indicate a stale index or query issue.",
        )
      }
    }
    offset += docsToProcess.length
    if (docsToProcess.length < BATCH_SIZE) {
      hasMore = false
    }
  }
  Logger.info(
    {
      bareSchemaName,
      emailToRemove,
      processedCount,
      deletedCount,
      updatedCount,
    },
    "[Permissions] Finished processing schema.",
  )
  return { updatedCount, deletedCount }
}

async function processDirectDeletesWithDateFilter(
  bareSchemaName: VespaSchema,
  directDeleteQueryWithDateFilter: string,
): Promise<number> {
  Logger.info(
    { bareSchemaName, directDeleteQueryWithDateFilter },
    "[Direct Deletion] Processing schema",
  )
  const BATCH_SIZE = 100
  let offset = 0
  let hasMore = true
  let totalDeleted = 0

  while (hasMore) {
    try {
      const searchPayload = {
        yql: directDeleteQueryWithDateFilter,
        hits: BATCH_SIZE,
        // offset: offset,
        // due to this we were missing documents in next search
        // previous docs won't be there in next search as permission is updated
        timeout: "10s",
        "ranking.profile": "unranked",
      }
      Logger.debug(
        { searchPayload },
        `[Direct Deletion] Fetching batch for ${bareSchemaName}`,
      )
      const searchResult: VespaSearchResponse =
        await vespaClient.search(searchPayload)
      const docsToDelete = searchResult.root?.children || []

      if (docsToDelete.length === 0) {
        hasMore = false
        break
      }
      Logger.info(
        { schema: bareSchemaName, count: docsToDelete.length },
        "[Direct Deletion] Found documents for deletion. Deleting...",
      )

      for (const doc of docsToDelete) {
        if (doc.fields && "docId" in doc.fields) {
          const docIdToDelete = doc.fields.docId as string
          if (docIdToDelete) {
            try {
              await DeleteDocument(docIdToDelete, bareSchemaName)
              totalDeleted++
            } catch (error) {
              Logger.error(
                { error, docIdToDelete, schema: bareSchemaName },
                "[Direct Deletion] Error deleting document",
              )
            }
          }
        }
      }
      Logger.info(
        {
          schema: bareSchemaName,
          batchDeleted: docsToDelete.length,
          totalDeleted,
        },
        "[Direct Deletion] Deleted batch.",
      )
      offset += docsToDelete.length
      if (docsToDelete.length < BATCH_SIZE) {
        hasMore = false
      }
    } catch (error) {
      Logger.error(
        { error, schema: bareSchemaName },
        "[Direct Deletion] Error searching/deleting documents",
      )
      hasMore = false // Stop on error to prevent infinite loops or repeated failures
    }
  }
  Logger.info(
    { schema: bareSchemaName, totalDeleted },
    "[Direct Deletion] Finished processing schema.",
  )
  return totalDeleted
}

export interface ClearUserDataOptions {
  startDate?: string // ISO 8601 date string e.g., "2023-01-01"
  endDate?: string // ISO 8601 date string e.g., "2023-01-31"
  servicesToClear?: string[] // e.g., ["drive", "gmail", "calendar"] or empty/undefined to clear all applicable
  // This flag determines if we should delete documents where the user is the *sole* owner in the permissions array,
  // or if we should delete any document where the user's email appears in permissions, regardless of other owners.
  // For a full user data wipe, this might be false. For a more targeted cleanup (e.g., just revoking access), this might be true.
  deleteOnlyIfSoleOwnerInPermissions?: boolean
}

export async function clearUserDataInVespa(
  emailToClear: string,
  options: ClearUserDataOptions = {},
): Promise<
  Record<string, { permissionsUpdated: number; directlyDeleted: number }>
> {
  Logger.info(
    { emailToClear, options },
    "Starting user data clearing process in Vespa.",
  )

  const {
    startDate,
    endDate,
    servicesToClear = Object.keys(serviceSchemaMapping),
    deleteOnlyIfSoleOwnerInPermissions = true,
  } = options

  let startDateMs: number | undefined
  let endDateMs: number | undefined

  if (startDate) {
    startDateMs = new Date(startDate).getTime()
  }
  if (endDate) {
    // Adjust end date to be inclusive of the whole day
    const ed = new Date(endDate)
    ed.setHours(23, 59, 59, 999)
    endDateMs = ed.getTime()
  }

  const results: Record<
    string,
    { permissionsUpdated: number; directlyDeleted: number }
  > = {}
  const fullNamespace = config.VESPA_NAMESPACE || "my_content"

  for (const serviceName of servicesToClear) {
    const serviceConfig = serviceSchemaMapping[serviceName]
    if (!serviceConfig) {
      Logger.warn(
        { serviceName },
        "Unknown service specified for clearing. Skipping.",
      )
      results[serviceName] = { permissionsUpdated: 0, directlyDeleted: 0 }
      continue
    }

    const bareSchemaName = serviceConfig.schema
    const fullSchemaName = `${fullNamespace}.${bareSchemaName}`
    const timestampField = serviceConfig.timestampField
    let permissionProcessingQuery = ""
    let yqlQueryForDirectDelete = "" // For cases like 'owner' field or direct user data like 'userSchema'

    Logger.info(
      { serviceName, schema: fullSchemaName, emailToClear },
      `Processing schema for service.`,
    )
    results[serviceName] = { permissionsUpdated: 0, directlyDeleted: 0 }

    // Construct date filter part for YQL
    let dateFilterYql = ""
    if (timestampField && startDateMs && endDateMs) {
      dateFilterYql = ` AND ${timestampField} >= ${startDateMs} AND ${timestampField} <= ${endDateMs}`
    } else if (timestampField && startDateMs) {
      dateFilterYql = ` AND ${timestampField} >= ${startDateMs}`
    } else if (timestampField && endDateMs) {
      dateFilterYql = ` AND ${timestampField} <= ${endDateMs}`
    }

    if (bareSchemaName === userSchema) {
      // User schema is typically a direct delete by email, date range might not apply or applies to a different field
      yqlQueryForDirectDelete = `select * from ${fullSchemaName} where email contains "${emailToClear}"`
      // If userSchema has a relevant timestamp for date filtering, add it.
      // For example, if it has 'lastLogin' or 'createdAt' and you want to apply the date filter:
      // if (dateFilterYql && serviceSchemaMapping.userProfile.timestampField) { // Assuming userProfile points to userSchema
      //    yqlQueryForDirectDelete += dateFilterYql.replace(serviceSchemaMapping.userProfile.timestampField, 'relevant_user_timestamp_field');
      // }
    } else if (
      bareSchemaName === mailSchema ||
      bareSchemaName === fileSchema ||
      bareSchemaName === mailAttachmentSchema ||
      bareSchemaName === eventSchema
    ) {
      // Schemas with a 'permissions' array
      permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${emailToClear}"${dateFilterYql}`
    }
    // Add other schema-specific logic here if needed

    // 1. Process permissions
    if (permissionProcessingQuery) {
      const initialPermissionCount = await getVespaDocumentCount(
        permissionProcessingQuery,
      )
      Logger.info(
        {
          schema: fullSchemaName,
          query: permissionProcessingQuery,
          count: initialPermissionCount,
        },
        "Initial count for permission processing",
      )
      if (initialPermissionCount > 0) {
        const permResults = await processPermissionUpdatesAndDeleteIfSoleOwner(
          bareSchemaName,
          permissionProcessingQuery,
          emailToClear,
          deleteOnlyIfSoleOwnerInPermissions,
        )
        results[serviceName].permissionsUpdated = permResults.updatedCount
        results[serviceName].directlyDeleted += permResults.deletedCount // Add to direct deletes
      } else {
        Logger.info(
          { schema: fullSchemaName, query: permissionProcessingQuery },
          "No documents found for permission processing.",
        )
      }
    }

    // 2. Process direct deletions (if a query is defined)
    if (yqlQueryForDirectDelete) {
      const initialDirectDeleteCount = await getVespaDocumentCount(
        yqlQueryForDirectDelete,
      )
      Logger.info(
        {
          schema: fullSchemaName,
          query: yqlQueryForDirectDelete,
          count: initialDirectDeleteCount,
        },
        "Initial count for direct deletion",
      )
      if (initialDirectDeleteCount > 0) {
        const directDeletedCount = await processDirectDeletesWithDateFilter(
          bareSchemaName,
          yqlQueryForDirectDelete,
        )
        results[serviceName].directlyDeleted += directDeletedCount
      } else {
        Logger.info(
          { schema: fullSchemaName, query: yqlQueryForDirectDelete },
          "No documents found for direct deletion.",
        )
      }
    }
    Logger.info(
      { serviceName, results: results[serviceName] },
      "Finished processing service.",
    )
  }

  Logger.info(
    { emailToClear, finalResults: results },
    "User data clearing process completed.",
  )
  return results
}
