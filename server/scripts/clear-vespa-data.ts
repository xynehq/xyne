import config from "../config"
import path from "path"
import fs from "fs/promises" // Using Node.js fs/promises for broader compatibility
import type {
  VespaSearchResponse,
  VespaUser,
  VespaFile,
  VespaEvent,
  VespaSchema,
  VespaUserQueryHistory,
  VespaGetResult,
} from "@xyne/vespa-ts/types" // VespaFile is already here
import {
  // VespaSchema, // No longer imported as a value
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  userQuerySchema,
  mailAttachmentSchema,
  chatContainerSchema,
  chatTeamSchema,
  chatMessageSchema,
  chatUserSchema,
  chatAttachmentSchema,
} from "@xyne/vespa-ts/types"

async function getVespaSchemas(): Promise<string[]> {
  // Returns prefixed names e.g. "my_content.file"
  // Determine path relative to the current file's directory
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const schemasDir = path.join(scriptDir, "../vespa/schemas")
  try {
    const files = await fs.readdir(schemasDir)
    const schemaNames = files
      .filter((file) => file.endsWith(".sd"))
      .map((file) => `my_content.${file.replace(".sd", "")}`) // No incorrect cast here
    return schemaNames
  } catch (error) {
    console.error(`Error reading Vespa schemas directory ${schemasDir}:`, error)
    return []
  }
}

import VespaClient from "@xyne/vespa-ts/client" // Import the Vespa client
import { GetDocument, UpdateDocument, DeleteDocument } from "@/search/vespa" // Added import

const vespaClient = new VespaClient() // Instantiate the client

function delay(ms: number): Promise<void> {
  // This function remains for any other potential use, but we remove specific calls.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Helper function to get document count for a given YQL query
async function getVespaDocumentCount(yqlQuery: string): Promise<number> {
  try {
    const countPayload = {
      yql: yqlQuery,
      hits: 0, // Only need count
      "ranking.profile": "unranked",
    }
    const searchResult: VespaSearchResponse =
      await vespaClient.search(countPayload)
    return searchResult.root?.fields?.totalCount || 0
  } catch (error) {
    console.error(
      `Error getting Vespa document count for query "${yqlQuery}":`,
      error,
    )
    return 0
  }
}

// Helper function to search and delete documents based on a query
async function deleteDocumentsByQuery(
  targetNamespace: string,
  targetCluster: string,
  schemaName: VespaSchema, // This is the bare schema name, e.g., "mail"
  yqlQuery: string,
  userId: string, // userId is used for logging/context, not directly in query
): Promise<void> {
  const BATCH_SIZE = 100 // Process documents in batches
  let offset = 0
  let hasMore = true
  let totalDeleted = 0

  while (hasMore) {
    try {
      const searchPayload = {
        yql: yqlQuery, // yqlQuery should already include the fully qualified schema name if needed (e.g., my_content.mail)
        hits: BATCH_SIZE,
        offset: offset,
        timeout: "10s",
        "ranking.profile": "unranked", // No need for ranking when just getting docIds
      }

      const searchResult: VespaSearchResponse =
        await vespaClient.search<VespaSearchResponse>(searchPayload)
      const docsToDelete = searchResult.root?.children || []

      if (docsToDelete.length === 0) {
        hasMore = false
        break
      }

      console.log(
        `Found ${docsToDelete.length} documents in schema '${schemaName}' (query context) for user '${userId}'. Deleting...`,
      )

      for (const doc of docsToDelete) {
        if (doc.fields && "docId" in doc.fields) {
          const docIdToDelete = doc.fields.docId as string
          if (docIdToDelete) {
            await DeleteDocument(docIdToDelete, schemaName)
            totalDeleted++
          }
        }
      }
      console.log(
        `Deleted batch of ${docsToDelete.length} documents for schema '${schemaName}', user '${userId}'. Total deleted so far: ${totalDeleted}`,
      )

      offset += docsToDelete.length
      if (docsToDelete.length < BATCH_SIZE) {
        hasMore = false
      }
    } catch (error) {
      console.error(
        `Error searching/deleting documents in schema ${schemaName} for user ${userId}:`,
        error,
      )
      hasMore = false
    }
  }
  console.log(
    `Finished deleting documents in schema '${schemaName}' for user '${userId}'. Total deleted: ${totalDeleted}`,
  )
}

// New helper function to process documents based on email in permissions
async function processDocumentsWithEmailPermissions(
  targetNamespace: string,
  targetCluster: string,
  bareSchemaName: VespaSchema, // This is the bare schema name, e.g., "file"
  vespaClient: VespaClient,
  permissionQuery: string,
  email: string, // The email to remove/check for
): Promise<void> {
  console.log(
    `[Permissions] Processing schema '${bareSchemaName}' for email ${email}. Fetch query: ${permissionQuery}`,
  )

  const lowercasedEmailToRemove = email.toLowerCase() // For case-insensitive comparison

  let offset = 0
  let hasMore = true
  const BATCH_SIZE = 50
  let processedCount = 0
  let deletedCount = 0
  let updatedCount = 0

  while (hasMore) {
    const searchPayload = {
      yql: permissionQuery,
      hits: BATCH_SIZE,
      offset: offset,
      timeout: "10s",
      "ranking.profile": "unranked",
    }

    console.log(
      `  [Permissions] Fetching batch for ${bareSchemaName} with offset ${offset}. Payload: ${JSON.stringify(searchPayload)}`,
    )
    const searchResult: VespaSearchResponse =
      await vespaClient.search(searchPayload)
    const docsToProcess = searchResult.root?.children || []
    console.log(
      `  [Permissions] Fetched ${docsToProcess.length} documents in this batch for ${bareSchemaName}.`,
    )

    if (docsToProcess.length === 0) {
      hasMore = false
      break
    }

    processedCount += docsToProcess.length
    console.log(
      `[Permissions] Total documents fetched so far for ${bareSchemaName}: ${processedCount}. Processing current batch...`,
    )

    for (const doc of docsToProcess) {
      if (
        !doc.fields ||
        !("docId" in doc.fields) ||
        !("permissions" in doc.fields)
      ) {
        console.warn(
          `[Permissions] Skipping document from '${bareSchemaName}' (Vespa ID: ${doc.id}, internal docId: ${(doc.fields as any)?.docId}) due to missing docId or permissions field. Fetched fields: ${JSON.stringify(doc.fields)}`,
        )
        continue
      }
      const docFields = doc.fields as { docId: string; permissions: string[] }
      const docIdToProcess = docFields.docId
      const currentPermissions = Array.isArray(docFields.permissions)
        ? docFields.permissions
        : []

      console.log(
        `[Permissions] Processing docId ${docIdToProcess} (Vespa ID: ${doc.id}) from schema ${bareSchemaName}. Current permissions: [${currentPermissions.join(", ")}] for email ${email}.`,
      )

      // Case-insensitive check if the email exists in permissions
      const emailExistsInPermissions = currentPermissions.some(
        (p) => p.toLowerCase() === lowercasedEmailToRemove,
      )

      if (emailExistsInPermissions) {
        // Case-insensitive filter to remove the email
        const updatedPermissions = currentPermissions.filter(
          (p) => p.toLowerCase() !== lowercasedEmailToRemove,
        )
        console.log(
          `  [Permissions] Email ${email} (match found) in permissions for docId ${docIdToProcess}. Original: [${currentPermissions.join(", ")}], After filtering ${email}: [${updatedPermissions.join(", ")}].`,
        )

        if (updatedPermissions.length === 0) {
          console.log(
            `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}': email ${email} was the last permission holder. Attempting to delete document.`,
          )
          await DeleteDocument(docIdToProcess, bareSchemaName)
          console.log(
            `    [Permissions] Successfully requested deletion for docId ${docIdToProcess}.`,
          )
          deletedCount++
        } else {
          console.log(
            `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}': email ${email} removed from permissions. Others remain. Attempting to update permissions to [${updatedPermissions.join(", ")}].`,
          )
          await UpdateDocument(bareSchemaName, docIdToProcess, {
            permissions: updatedPermissions,
          })
          console.log(
            `    [Permissions] Successfully requested permission update for docId ${docIdToProcess} to [${updatedPermissions.join(", ")}].`,
          )
          updatedCount++
        }
      } else {
        console.warn(
          `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}' was fetched by query "${permissionQuery}", but email ${email} NOT in its permissions [${currentPermissions.join(", ")}]. This might indicate an issue or stale index. Skipping modification for this document.`,
        )
      }
    }
    offset += docsToProcess.length
    if (docsToProcess.length < BATCH_SIZE) {
      hasMore = false
    }
  }
  console.log(
    `[Permissions] Finished processing schema '${bareSchemaName}' for email ${email}. Total Fetched: ${processedCount}, Deleted: ${deletedCount}, Permissions Updated: ${updatedCount}.`,
  )
}

async function clearAllDataForSchema(fullSchemaName: string): Promise<void> {
  console.log(`Clearing all data for schema: ${fullSchemaName}`)
  const initialCount = await getVespaDocumentCount(
    `select * from sources ${fullSchemaName} where true`,
  )
  console.log(
    `Schema '${fullSchemaName}': Initial count before clearing: ${initialCount}`,
  )

  if (initialCount === 0) {
    console.log(
      `Schema '${fullSchemaName}': No documents found. No deletion needed.`,
    )
    return
  }

  try {
    const targetNamespace = "my_content"
    const targetCluster = "my_content"
    const bareSchemaNameString = fullSchemaName.replace(
      `${targetNamespace}.`,
      "",
    )
    const bareSchemaName = bareSchemaNameString as any as VespaSchema // Changed cast here

    await deleteDocumentsByQuery(
      targetNamespace,
      targetCluster,
      bareSchemaName,
      `select * from sources ${fullSchemaName} where true`,
      "all_users",
    )

    console.log(
      `Finished attempting to clear all data for schema: ${fullSchemaName}`,
    )
    const finalCount = await getVespaDocumentCount(
      `select * from sources ${fullSchemaName} where true`,
    )
    console.log(
      `Schema '${fullSchemaName}': Final count after attempted clearing: ${finalCount}.`,
    )
  } catch (error) {
    console.error(`Error clearing data for schema ${fullSchemaName}:`, error)
  }
}

async function clearAllVespaData(): Promise<void> {
  console.log(
    "Starting to clear all data from Vespa (for schemas in 'my_content' namespace)...",
  )
  const initialTotalCount = await getVespaDocumentCount(
    "select * from sources * where true",
  )
  console.log(
    `Total documents across all sources before clearing: ${initialTotalCount}`,
  )

  const schemas = await getVespaSchemas() // schemas here are prefixed e.g. "my_content.file"
  if (schemas.length === 0) {
    console.warn(
      "No Vespa schemas (for 'my_content' namespace) found. Aborting clear operation.",
    )
    return
  }
  // For this function, we'll assume it's meant to clear all listed schemas.
  for (const schema of schemas) {
    // schema is "my_content.file"
    await clearAllDataForSchema(schema) // clearAllDataForSchema expects prefixed name
  }
  console.log(
    "Finished clearing all data from Vespa (for 'my_content' schemas).",
  )

  const finalTotalCount = await getVespaDocumentCount(
    "select * from sources * where true",
  )
  console.log(
    `Total documents across all sources after attempted clearing: ${finalTotalCount}.`,
  )
}

async function clearVespaDataByUser(email: string): Promise<void> {
  console.log(
    `Starting to clear data for user: ${email} from Vespa (primarily 'my_content' namespace)...`,
  )
  const allPrefixedSchemas = await getVespaSchemas() // allPrefixedSchemas contains "my_content.file", etc.
  if (allPrefixedSchemas.length === 0) {
    console.warn(
      "No Vespa schemas (for 'my_content' namespace) found. Aborting clear operation for user.",
    )
    return
  }

  const targetNamespace = "my_content"
  const targetCluster = "my_content"

  const chatSchemasToSkip: VespaSchema[] = [
    chatMessageSchema,
    chatContainerSchema,
    chatTeamSchema,
    chatUserSchema,
    chatAttachmentSchema, // Now valid as chatAttachment is in VespaSchema type
  ]

  for (const fullSchemaName of allPrefixedSchemas) {
    const bareSchemaNameString = fullSchemaName.replace(
      `${targetNamespace}.`,
      "",
    )
    // We need to assert this string to VespaSchema. This is generally safe here because
    // getVespaSchemas derives names from actual .sd files which correspond to VespaSchema types.
    const bareSchemaName = bareSchemaNameString as any as VespaSchema // Using as any as VespaSchema to satisfy linter

    if (chatSchemasToSkip.includes(bareSchemaName)) {
      console.log(
        `Skipping chat schema: ${fullSchemaName} (bare: ${bareSchemaName}) for user-specific deletion.`,
      )
      continue
    }

    let yqlQueryForDirectDelete = ""
    let permissionProcessingQuery = ""
    let postPermissionYqlDeleteQuery = "" // For deletions after permission processing (e.g. event creator/attendee)

    console.log(
      `Processing schema ${fullSchemaName} (bare: ${bareSchemaName}) for user ${email}`,
    )

    try {
      switch (bareSchemaName) {
        case userSchema:
          yqlQueryForDirectDelete = `select * from ${fullSchemaName} where email contains "${email}"`
          break

        case mailSchema:
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          // Also, directly delete mails owned by the user, regardless of permissions array content for that user.
          yqlQueryForDirectDelete = `select * from ${fullSchemaName} where owner contains "${email}"`
          // Q: What about from, to, cc, bcc if not owner and not in permissions array? For now, these are not deleted.
          break

        case mailAttachmentSchema:
          // Mail attachments DO have a permissions field.
          // We will process them based on that, similar to files and mails.
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          yqlQueryForDirectDelete = "" // Clear any owner-based deletion attempt
          break

        case fileSchema: {
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          break
        }

        case eventSchema: {
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          // Additionally, delete events where the user is creator, organizer or attendee
          // This query will run *after* permission processing for this schema.
          postPermissionYqlDeleteQuery = `select * from ${fullSchemaName} where creator.email contains "${email}" or organizer.email contains "${email}" or attendees.email contains "${email}"`
          break
        }

        case userQuerySchema:
          console.log(
            `Skipping schema '${userQuerySchema}' (full: ${fullSchemaName}) for email ${email}.`,
          )
          yqlQueryForDirectDelete = "" // Ensure it's skipped
          permissionProcessingQuery = ""
          break

        default:
          console.log(
            `No specific user deletion logic for schema: ${fullSchemaName} (bare: ${bareSchemaName}). Skipping.`,
          )
          continue
      }

      // 1. Process documents based on permissions array (if query is set)
      if (permissionProcessingQuery) {
        const initialCount = await getVespaDocumentCount(
          permissionProcessingQuery,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for permission processing (query: ${permissionProcessingQuery}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await processDocumentsWithEmailPermissions(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            vespaClient, // Pass the global client
            permissionProcessingQuery,
            email,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for permission processing (query: ${permissionProcessingQuery}).`,
          )
        }
      }

      // 2. Process direct deletions (if query is set)
      if (yqlQueryForDirectDelete) {
        const initialCount = await getVespaDocumentCount(
          yqlQueryForDirectDelete,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for direct deletion (query: ${yqlQueryForDirectDelete}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await deleteDocumentsByQuery(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            yqlQueryForDirectDelete,
            email,
          )
          const finalCount = await getVespaDocumentCount(
            yqlQueryForDirectDelete,
          )
          console.log(
            `Schema '${fullSchemaName}': Final count after direct deletion (query: ${yqlQueryForDirectDelete}): ${finalCount}.`,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for direct deletion (query: ${yqlQueryForDirectDelete}).`,
          )
        }
      }

      // 3. Process post-permission deletions (e.g., for event roles, if query is set)
      if (postPermissionYqlDeleteQuery) {
        const initialCount = await getVespaDocumentCount(
          postPermissionYqlDeleteQuery,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for post-permission deletion (query: ${postPermissionYqlDeleteQuery}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await deleteDocumentsByQuery(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            postPermissionYqlDeleteQuery,
            email,
          )
          const finalCount = await getVespaDocumentCount(
            postPermissionYqlDeleteQuery,
          )
          console.log(
            `Schema '${fullSchemaName}': Final count after post-permission deletion (query: ${postPermissionYqlDeleteQuery}): ${finalCount}.`,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for post-permission deletion (query: ${postPermissionYqlDeleteQuery}).`,
          )
        }
      }
    } catch (error: any) {
      console.error(
        `Error processing schema ${fullSchemaName} (bare: ${bareSchemaName}) for user ${email}:`,
        error,
      )
    }
  }
  console.log(`Finished clearing data for user: ${email} from Vespa.`)
}

async function testFileDocumentOperations(): Promise<void> {
  const docIdToTest = "" // Id of the doc to remove
  const userToRemove = ""
  const schemaName: VespaSchema = "file" // Schema from which the document has to be removed

  console.log(
    `---> Starting testFileDocumentOperations for docId: ${docIdToTest}, user: ${userToRemove} <---`,
  )

  try {
    // 1. Initial GET
    console.log(
      `[Test] 1. Attempting to GET document: ${docIdToTest} from schema ${schemaName}`,
    )
    let doc = await GetDocument(schemaName, docIdToTest)
    if (doc) {
      console.log(
        `  [Test] GET successful. Document fields:`,
        JSON.stringify(doc.fields),
      )
      const permissions = (doc.fields as any)?.permissions as
        | string[]
        | undefined
      if (permissions) {
        console.log(`  [Test] Current permissions: [${permissions.join(", ")}]`)
        if (
          permissions
            .map((p) => p.toLowerCase())
            .includes(userToRemove.toLowerCase())
        ) {
          console.log(`  [Test] User ${userToRemove} IS in permissions.`)
        } else {
          console.log(`  [Test] User ${userToRemove} IS NOT in permissions.`)
        }
      } else {
        console.log("  [Test] Permissions field is missing or not an array.")
      }
    } else {
      console.log("  [Test] GET failed or document not found initially.")
    }

    // 2. UPDATE (remove the user from permissions)
    if (doc) {
      // Proceed only if doc was found
      const currentPermissions =
        ((doc.fields as any)?.permissions as string[] | undefined) || []
      const lowerUserToRemove = userToRemove.toLowerCase()
      const updatedPermissions = currentPermissions.filter(
        (p) => p.toLowerCase() !== lowerUserToRemove,
      )

      if (
        currentPermissions.some((p) => p.toLowerCase() === lowerUserToRemove)
      ) {
        console.log(
          `[Test] 2. Attempting to UPDATE document: ${docIdToTest} in schema ${schemaName} to remove user ${userToRemove}. New permissions: [${updatedPermissions.join(", ")}]`,
        )
        await UpdateDocument(schemaName, docIdToTest, {
          permissions: updatedPermissions,
        })
        console.log("  [Test] UPDATE operation was successful.")

        // 3. Post-Update GET
        console.log("[Test] 3. Attempting to GET document post-UPDATE.")
        doc = await GetDocument(schemaName, docIdToTest)
        if (doc) {
          console.log(
            "  [Test] Post-UPDATE GET successful. Document fields:",
            JSON.stringify(doc.fields),
          )
          const newPermissions = (doc.fields as any)?.permissions as
            | string[]
            | undefined
          if (newPermissions) {
            console.log(
              `  [Test] New permissions: [${newPermissions.join(", ")}]`,
            )
            if (
              newPermissions
                .map((p) => p.toLowerCase())
                .includes(userToRemove.toLowerCase())
            ) {
              console.error(
                `  [Test] ERROR: User ${userToRemove} IS STILL in permissions post-update.`,
              )
            } else {
              console.log(
                `  [Test] SUCCESS: User ${userToRemove} IS NOT in permissions post-update.`,
              )
            }
          } else {
            console.log(
              "  [Test] Permissions field is missing or not an array post-update.",
            )
          }
        } else {
          console.error(
            "  [Test] ERROR: Post-UPDATE GET failed. Document not found.",
          )
        }
      } else {
        console.log(
          `[Test] User ${userToRemove} was not in initial permissions. Skipping UPDATE.`,
        )
      }
    }
  } catch (error: any) {
    console.error(
      "[Test] An error occurred during testFileDocumentOperations:",
      error,
    )
  } finally {
    console.log("---> Finished testFileDocumentOperations <---")
  }
}
// Main execution
;(async () => {
  try {
    // await testFileDocumentOperations(); // Comment this out

    const userEmailToClear = ""
    await clearVespaDataByUser(userEmailToClear) // Ensure this is active
  } catch (error: any) {
    console.error("Error in main execution:", error)
  }
})()
