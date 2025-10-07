#!/usr/bin/env bun

/*
 * Simple script to clear all workflow-related data using TRUNCATE with CASCADE
 * This script truncates all workflow tables, resets identity sequences, and keeps the table structure intact
 */

import { db } from "@/db/client"
import { sql } from "drizzle-orm"

async function runSQL(query: any, description: string): Promise<void> {
  console.log(`\n🔄 ${description}...`)
  try {
    await db.execute(query)
    console.log(`✅ ${description} completed`)
  } catch (error) {
    console.error(`❌ ${description} failed:`, error)
    throw error
  }
}

async function getTableCount(tableName: string): Promise<number> {
  try {
    const result = await db.execute(sql`SELECT COUNT(*) FROM ${sql.identifier(tableName)}`)
    return parseInt(result[0]?.count as string) || 0
  } catch (error) {
    console.error(`Failed to get count for ${tableName}:`, error)
    return -1
  }
}

async function logCounts(prefix: string): Promise<void> {
  console.log(`\n📊 ${prefix} counts:`)
  const tables = [
    'tool_execution',
    'workflow_step_execution',
    'workflow_execution', 
    'workflow_step_template',
    'workflow_template',
    'workflow_tool'
  ]
  
  for (const table of tables) {
    const count = await getTableCount(table)
    console.log(`   ${table}: ${count}`)
  }
}

async function clearWorkflowData(): Promise<void> {
  console.log('🧹 Starting workflow data cleanup using TRUNCATE with CASCADE...')
  
  // Show initial counts
  await logCounts('Initial')
  
  try {
    // Truncate all workflow tables with CASCADE and RESTART IDENTITY
    // This efficiently clears all data, handles foreign key constraints automatically,
    // and resets auto-increment sequences to start from 1
    await runSQL(
      sql`TRUNCATE TABLE tool_execution, workflow_step_execution, workflow_execution, workflow_step_template, workflow_template, workflow_tool RESTART IDENTITY CASCADE`,
      'Truncating all workflow and tool execution tables with CASCADE and RESTART IDENTITY'
    )
    
    // Show final counts
    await logCounts('Final')
    
    console.log('\n🎉 Workflow data cleanup completed successfully!')
    
  } catch (error) {
    console.error('\n❌ Workflow data cleanup failed!')
    throw error
  }
}

// Run the cleanup
clearWorkflowData()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))