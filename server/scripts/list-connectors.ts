#!/usr/bin/env bun
/**
 * List all connectors in the database
 */

import { db } from "../db/client"
import { connectors } from "../db/schema"

async function listConnectors() {
  console.log("🔍 Fetching all connectors from database...")

  try {
    const allConnectors = await db.select().from(connectors)

    console.log(`\n✅ Found ${allConnectors.length} connector(s)\n`)

    if (allConnectors.length === 0) {
      console.log("No connectors in database yet.")
      return
    }

    for (const connector of allConnectors) {
      try {
        console.log(`📊 Connector ID: ${connector.id}`)
        console.log(`   External ID: ${connector.externalId}`)
        console.log(`   Name: ${connector.name}`)
        console.log(`   App: ${connector.app}`)
        console.log(`   Type: ${connector.type}`)
        console.log(`   Auth Type: ${connector.authType}`)
        console.log(`   Status: ${connector.status}`)
        console.log(`   User ID: ${connector.userId}`)
        console.log(`   Has credentials: ${!!connector.credentials}`)
        console.log(`   Has oauthCredentials: ${!!connector.oauthCredentials}`)
        console.log(`   Created: ${connector.createdAt}`)
        console.log(``)
      } catch (error: any) {
        console.log(`⚠️  Connector ID ${connector.id}: Error reading data - ${error.message}`)
        console.log(``)
      }
    }
  } catch (error: any) {
    console.error("❌ Error fetching connectors:", error.message)
    throw error
  }
}

listConnectors()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error.message)
    process.exit(1)
  })
