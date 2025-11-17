#!/usr/bin/env bun
/**
 * Manually update Zoho connector with departmentId
 * Usage: bun run scripts/update-zoho-department.ts
 */

import { db } from "../db/client"
import { connectors } from "../db/schema"
import { eq } from "drizzle-orm"
import { Apps, AuthType } from "../shared/types"

async function updateZohoDepartment() {
  console.log("🔍 Finding Zoho Desk connector...")

  // Find the Zoho Desk connector
  const zohoConnectors = await db
    .select()
    .from(connectors)
    .where(eq(connectors.app, Apps.ZohoDesk))

  if (zohoConnectors.length === 0) {
    console.log("❌ No Zoho Desk connector found")
    return
  }

  console.log(`✅ Found ${zohoConnectors.length} Zoho connector(s)`)

  for (const connector of zohoConnectors) {
    console.log(`\n📊 Connector ID: ${connector.id}`)
    console.log(`   External ID: ${connector.externalId}`)
    console.log(`   Status: ${connector.status}`)
    console.log(`   Has oauthCredentials: ${!!connector.oauthCredentials}`)

    // Parse existing oauthCredentials (Drizzle auto-decrypts)
    let oauthCreds: any = {}
    if (connector.oauthCredentials) {
      try {
        oauthCreds = JSON.parse(connector.oauthCredentials as string)
        console.log(`   Current departmentIds: ${JSON.stringify(oauthCreds.departmentIds || [])}`)
      } catch (e) {
        console.log(`   ⚠️  Could not parse existing oauthCredentials`)
      }
    }

    // Add departmentId for Credit department
    const updatedCreds = {
      ...oauthCreds,
      departmentIds: ["45884400021353108"], // Credit department
      departments: [
        {
          id: "45884400021353108",
          name: "Credit",
        },
      ],
    }

    console.log(`\n🔄 Updating connector with departmentId...`)

    // Update the connector (Drizzle auto-encrypts)
    await db
      .update(connectors)
      .set({
        oauthCredentials: JSON.stringify(updatedCreds),
      })
      .where(eq(connectors.id, connector.id))

    console.log(`✅ Updated connector ${connector.id} with departmentId: 45884400021353108 (Credit)`)
  }

  console.log(`\n🎉 Done! Your connector now has departmentId configured.`)
  console.log(`\n💡 Next steps:`)
  console.log(`   1. Try searching for Zoho tickets`)
  console.log(`   2. Results should be filtered to Credit department (45884400021353108)`)
}

updateZohoDepartment()
  .then(() => {
    console.log("\n✅ Script completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    console.error("\n❌ Error:", error.message)
    console.error(error.stack)
    process.exit(1)
  })
