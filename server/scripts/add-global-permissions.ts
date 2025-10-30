// #!/usr/bin/env bun

// import { getLogger } from "@/logger"
// import { Subsystem } from "@/types"
// import { UpdateDocument } from "@/search/vespa"
// import config from "@/config.ts"

// const logger = getLogger(Subsystem.Vespa).child({
//   module: "add-global-permissions",
// })

// // Function to query all documents in batches
// async function queryAllDocuments(offset = 0, limit = 100) {
//   // YQL to select all documents from all sources
//   // limit = offset + limit
//   console.log("Offset:", offset, "Limit:", limit)
//   const yql = `select * from sources * where true limit ${limit} offset ${offset}`

//   const params = new URLSearchParams({
//     yql,
//     hits: limit.toString(),
//     // Specify the document summary to ensure we get the necessary fields
//     "summary": "default",
//   })

//   const url = `${config.vespaEndpoint}/search/?${params.toString()}`

//   const response = await fetch(url, {
//     method: "GET",
//     headers: { Accept: "application/json" },
//   })

//   if (!response.ok) {
//     const errorBody = await response.text()
//     throw new Error(
//       `Failed to query documents: ${response.status} - ${errorBody}`,
//     )
//   }

//   const data = await response.json()
//   return {
//     documents: data.root?.children || [],
//     totalCount: data.root?.fields?.totalCount || 0,
//   }
// }

// // Main function to add a global permission to all documents
// async function addGlobalPermission() {
//   const emailToAdd = process.argv[2]

//   if (!emailToAdd) {
//     logger.error("Usage: bun run server/scripts/add-global-permissions.ts <email-to-add>")
//     process.exit(1)
//   }

//   // List of schemas that are known to have a 'permissions' field.
//   const schemasWithPermissions = new Set([
//     "chat_container",
//     "chat_user",
//     "event",
//     "file",
//     "mail",
//     "mail_attachment",
//   ]);

//   logger.warn(
//     `Starting script to add global permission for: ${emailToAdd}. This is a high-risk operation.`,
//   )

//   let offset = 0
//   const limit = 100
//   let totalUpdated = 0
//   let alreadyPresent = 0
//   let totalProcessed = 0

//   while (true) {
//     const { documents, totalCount } = await queryAllDocuments(offset, limit)

//     if (documents.length === 0) {
//       logger.info("No more documents to process.")
//       break
//     }

//     totalProcessed += documents.length
//     logger.info(
//       `Processing batch: ${offset + 1}-${offset + documents.length} of approximately ${totalCount} documents.`,
//     )

//     for (const doc of documents) {
//       const fields = doc.fields
//       const docId = fields.docId
//       const schema = doc.id.split(":")[2] // Extract schema from document ID (e.g., 'mail', 'file')

//       if (!docId || !schema) {
//         logger.warn(`Skipping document with missing docId or schema: ${doc.id}`)
//         continue
//       }

//       // Only process schemas that are known to have a permissions field
//       if (!schemasWithPermissions.has(schema)) {
//         continue
//       }

//       const currentPermissions = fields.permissions || []

//       // Check if the email is already in the permissions array
//       if (currentPermissions.map((p: string) => p.toLowerCase()).includes(emailToAdd.toLowerCase())) {
//         alreadyPresent++
//         continue
//       }

//       // Add the new email to the existing permissions
//       const newPermissions = [...currentPermissions, emailToAdd]

//       // Update the document in Vespa
//       try {
//         await UpdateDocument(schema, docId, {
//           permissions: newPermissions,
//         })

//         logger.info(
//           `Updated docId ${docId} in schema ${schema}. New permissions count: ${newPermissions.length}`,
//         )
//         totalUpdated++
//       } catch (error) {
//         logger.error(`Failed to update docId ${docId} in schema ${schema}: ${error}`)
//       }
//     }

//     offset += limit

//     // Break if we've processed all available documents
//     // if (documents.length < limit) {
//     //   break
//     // }
//   }

//   logger.info("-------------------------------------------------")
//   logger.info("Global Permissions Update Complete!")
//   logger.info(`Total documents processed: ${totalProcessed}`)
//   logger.info(`Documents updated: ${totalUpdated}`)
//   logger.info(`Documents where email was already present: ${alreadyPresent}`)
//   logger.info("-------------------------------------------------")
// }

// // Run the script
// addGlobalPermission()
//   .then(() => {
//     logger.info("Script finished successfully.")
//     process.exit(0)
//   })
//   .catch((error) => {
//     logger.error("Script failed with an unhandled error:", error)
//     process.exit(1)
//   })

// #!/usr/bin/env bun

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { UpdateDocument } from "@/search/vespa"
import config, { CLUSTER } from "@/config"
import { chatMessageSchema, userQuerySchema, userSchema } from "@xyne/vespa-ts"

const logger = getLogger(Subsystem.Vespa).child({
  module: "fix-calendar-permissions",
})

const userEmail = "arshith.balara@juspay.in"
// Query calendar emails using YQL
async function queryCalendarEmails(offset = 0, limit = 100) {
  const yql = `select * from sources mail, event, file, user, mail_attachment where true limit ${limit} offset ${offset}`

  const payload = {
    yql,
    hits: limit,
    offset,
    timeout: "30s",
    "ranking.profile": "unranked",
    "presentation.summary": "default",
    maxHits: limit + 10,
    maxOffset: 1000000,
  }

  const url = `${config.vespaEndpoint}/search/`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Failed to query calendar emails: ${response.status}`)
  }

  const data = await response.json()
  return {
    documents: data.root?.children || [],
    totalCount: data.root?.fields?.totalCount || 0,
  }
}

// Main function to fix calendar permissions
async function fixCalendarPermissions() {
  let offset = 0
  const limit = 100
  let totalFixed = 0
  let alreadyCorrect = 0

  logger.info("Starting calendar permissions fix using YQL query...")

  while (true) {
    const { documents, totalCount } = await queryCalendarEmails(
      offset,
      limit + offset,
    )

    if (documents.length === 0) break

    logger.info(
      `Processing batch: ${offset + 1}-${offset + documents.length} of ${totalCount} calendar emails`,
    )

    for (const doc of documents) {
      const fields = doc.fields
      const mailId = fields.mailId || ""
      const userMap = fields.userMap || {}
      const currentPermissions = fields.permissions || []
      const docId = fields.docId

      if (
        fields.sddocname == userQuerySchema ||
        fields.sddocname == chatMessageSchema
      ) {
        continue
      }
      if (currentPermissions.includes(userEmail)) {
        logger.info(`skipping update, user email already exsit`)
        continue
      }
      // Update permissions
      try {
        await UpdateDocument(fields.sddocname, docId, {
          ...(fields.sddocname == userSchema
            ? { owner: userEmail }
            : { permissions: [...currentPermissions, userEmail] }),
        })

        logger.info(`updating ${fields.sddocname} docId : ${docId}`)
        totalFixed++
      } catch (error) {
        logger.error(`Failed to update ${docId}: ${error}`)
      }
    }

    offset += limit

    // Break if we've processed all documents
    if (documents.length < limit) break
  }

  logger.info(
    `Migration complete! Fixed ${totalFixed} calendar emails, ${alreadyCorrect} were already correct`,
  )
}

// Run the script
fixCalendarPermissions()
  .then(() => {
    logger.info("Calendar permissions migration completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    logger.error("Migration failed:", error)
    process.exit(1)
  })
