#!/usr/bin/env bun

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { UpdateDocument } from "@/search/vespa"
import config, { CLUSTER } from "@/config"

const logger = getLogger(Subsystem.Vespa).child({
  module: "fix-calendar-permissions",
})

// Query calendar emails using YQL
async function queryCalendarEmails(offset = 0, limit = 100) {
  const yql = `select * from sources mail where mailId matches 'calendar-' limit ${limit} offset ${offset}`

  const payload = {
    yql,
    hits: limit,
    offset,
    timeout: "30s",
    "ranking.profile": "unranked",
    "presentation.summary": "default",
    maxHits: limit + 10,
    maxOffset: offset + 1000,
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

      // Get user email from userMap (the key)
      const userEmails = Object.keys(userMap)
      if (userEmails.length === 0) {
        logger.warn(`No user found in userMap for calendar email: ${docId}`)
        continue
      }

      if (userEmails.length > 1) {
        logger.warn(
          `Multiple users found in userMap for calendar email: ${docId} (users: ${userEmails.join(", ")}), skipping for manual review`,
        )
        continue
      }

      const userEmail = userEmails[0].toLowerCase()
      const expectedPermissions = [userEmail]

      // Check if already correct
      if (
        currentPermissions.length === 1 &&
        currentPermissions[0].toLowerCase() === userEmail
      ) {
        alreadyCorrect++
        continue
      }

      // Update permissions
      try {
        await UpdateDocument("mail", docId, {
          permissions: expectedPermissions,
        })

        logger.info(
          `Fixed calendar email ${docId}: [${currentPermissions.join(", ")}] → [${userEmail}]`,
        )
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
