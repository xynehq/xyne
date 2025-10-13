#!/usr/bin/env bun
/**
 * Script to insert sample JQL query data into Vespa
 * Usage: bun run scripts/insertJQLSample.ts
 */

import { insertSampleJQLQuery, handleJQLDataImport } from "@/integrations/jira"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Script).child({ module: "insertJQLSample" })

// Your corrected sample data
const sampleData = {
  id: "A.1",
  section: "A. Basic Filters",
  nlq: "Show me all open issues",
  jql: "status = Open",
  description: "Issues currently in the Open status.",
  query_summary: "Natural query: 'Show me all open issues'. Synonyms: tickets, items, bugs. Paraphrases: 'List open tickets', 'Open issues list', 'Give me active issues'. This JQL filters issues where the status field equals Open. Fields involved: status. Entity value: Open. Purpose: Useful for tracking ongoing work that has not been resolved yet.",
  synonyms: ["tickets", "items", "bugs"],
  paraphrases: ["List open tickets", "Open issues list", "Give me active issues"],
  intents: ["browse", "status"],
  fields: ["status"],
  entities: {"status": "Open"}, // Will be converted to JSON string
  product: ["Jira Core"],
  why: "Basic filter to identify active work items still marked as Open.",
  notes: "Ensure 'Open' matches your workflow; some instances may use 'In Progress'."
}

async function main() {
  try {
    Logger.info("Starting JQL sample data insertion...")
    
    // Method 1: Insert using the sample function
    Logger.info("Inserting via insertSampleJQLQuery()...")
    await insertSampleJQLQuery()
    Logger.info("✅ Sample query inserted successfully")
    
    // Method 2: Insert using the generic handler (with your data)
    Logger.info("Inserting via handleJQLDataImport()...")
    const result = await handleJQLDataImport(sampleData, {
      validate: true,
      skipErrors: false
    })
    
    Logger.info("✅ JQL data import completed", {
      inserted: result.inserted,
      failed: result.failed,
      success: result.success
    })
    
    if (result.errors.length > 0) {
      Logger.warn("Errors encountered:", result.errors)
    }
    
  } catch (error) {
    Logger.error(error, "❌ Failed to insert JQL sample data")
    process.exit(1)
  }
}

// Run the script
main()
  .then(() => {
    Logger.info("🎉 Script completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    Logger.error(error, "💥 Script failed")
    process.exit(1)
  })