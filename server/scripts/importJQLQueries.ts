#!/usr/bin/env bun
/**
 * Script to import JQL queries from JSON file
 * Usage: bun run scripts/importJQLQueries.ts [file-path]
 * Example: bun run scripts/importJQLQueries.ts ./data/jql-queries.json
 */

import { handleJQLDataImport } from "@/integrations/jira"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { promises as fs } from "fs"
import path from "path"

const Logger = getLogger(Subsystem.Script).child({ module: "importJQLQueries" })

async function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    Logger.error("Usage: bun run scripts/importJQLQueries.ts <json-file-path>")
    Logger.info("Example: bun run scripts/importJQLQueries.ts ./data/jql-queries.json")
    process.exit(1)
  }
  
  const filePath = args[0]
  const resolvedPath = path.resolve(filePath)
  
  try {
    Logger.info(`Reading JQL queries from: ${resolvedPath}`)
    
    // Check if file exists
    await fs.access(resolvedPath)
    
    // Read and parse JSON file
    const fileContent = await fs.readFile(resolvedPath, 'utf-8')
    const jsonData = JSON.parse(fileContent)
    
    // Validate it's an array
    if (!Array.isArray(jsonData)) {
      throw new Error("JSON file must contain an array of JQL queries")
    }
    
    Logger.info(`Found ${jsonData.length} queries in file`)
    
    // Import the data
    const result = await handleJQLDataImport(jsonData, {
      validate: true,
      skipErrors: true // Continue on individual errors
    })
    
    Logger.info("✅ JQL queries import completed", {
      total: jsonData.length,
      inserted: result.inserted,
      failed: result.failed,
      success: result.success
    })
    
    if (result.errors.length > 0) {
      Logger.warn("Errors encountered:")
      result.errors.forEach((error, index) => {
        Logger.warn(`  ${index + 1}. ${error}`)
      })
    }
    
    if (result.failed > 0) {
      Logger.warn(`⚠️  ${result.failed} queries failed to import`)
    }
    
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      Logger.error(`❌ File not found: ${resolvedPath}`)
    } else if (error instanceof SyntaxError) {
      Logger.error(`❌ Invalid JSON format in file: ${resolvedPath}`)
    } else {
      Logger.error(error, "❌ Failed to import JQL queries")
    }
    process.exit(1)
  }
}

// Run the script
main()
  .then(() => {
    Logger.info("🎉 Import script completed")
    process.exit(0)
  })
  .catch((error) => {
    Logger.error(error, "💥 Import script failed")
    process.exit(1)
  })