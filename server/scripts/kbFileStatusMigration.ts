#!/usr/bin/env node
/**
 * Simple migration script to update status fields for existing collections and collection_items
 * Processes in batches of 100 records at a time
 */

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { sql } from "drizzle-orm"

const BATCH_SIZE = 100

// Database connection
const connection = postgres(process.env.DATABASE_URL!)
const db = drizzle(connection)

async function migrateCollectionItems() {
  console.log("🔄 Starting collection_items migration...")

  let totalUpdated = 0
  let batchCount = 0

  while (true) {
    batchCount++
    console.log(`Processing collection_items batch ${batchCount}...`)

    // Update batch of collection_items
    const result = await db.execute(sql`
      UPDATE collection_items 
      SET 
        status_message = CASE 
          WHEN status_message IS NULL OR status_message = '' 
          THEN 'Successfully uploaded' 
          ELSE status_message 
        END,
        upload_status = CASE 
          WHEN upload_status IS NULL OR upload_status = '' 
          THEN 'completed' 
          ELSE upload_status 
        END,
        retry_count = CASE 
          WHEN retry_count IS NULL 
          THEN 0 
          ELSE retry_count 
        END,
        updated_at = NOW()
      WHERE id IN (
        SELECT id FROM collection_items 
        WHERE deleted_at IS NULL 
          AND (
            status_message IS NULL 
            OR status_message = '' 
            OR upload_status IS NULL 
            OR upload_status = ''
            OR retry_count IS NULL
          )
        LIMIT ${BATCH_SIZE}
      )
    `)

    const updatedRows = result.count || 0
    totalUpdated += updatedRows

    console.log(`Batch ${batchCount}: Updated ${updatedRows} collection_items`)

    if (updatedRows === 0) {
      console.log("✅ No more collection_items to update")
      break
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  console.log(
    `📊 Collection_items migration complete: ${totalUpdated} total records updated`,
  )
  return totalUpdated
}

async function migrateCollections() {
  console.log("🔄 Starting collections migration...")

  let totalUpdated = 0
  let batchCount = 0

  while (true) {
    batchCount++
    console.log(`Processing collections batch ${batchCount}...`)

    // Update batch of collections
    const result = await db.execute(sql`
      UPDATE collections 
      SET 
        status_message = CASE 
          WHEN status_message IS NULL OR status_message = '' 
          THEN 'Collection created successfully' 
          ELSE status_message 
        END,
        upload_status = CASE 
          WHEN upload_status IS NULL OR upload_status = '' 
          THEN 'completed' 
          ELSE upload_status 
        END,
        retry_count = CASE 
          WHEN retry_count IS NULL 
          THEN 0 
          ELSE retry_count 
        END,
        updated_at = NOW()
      WHERE id IN (
        SELECT id FROM collections 
        WHERE deleted_at IS NULL 
          AND (
            status_message IS NULL 
            OR status_message = '' 
            OR upload_status IS NULL 
            OR upload_status = ''
            OR retry_count IS NULL
          )
        LIMIT ${BATCH_SIZE}
      )
    `)

    const updatedRows = result.count || 0
    totalUpdated += updatedRows

    console.log(`Batch ${batchCount}: Updated ${updatedRows} collections`)

    if (updatedRows === 0) {
      console.log("✅ No more collections to update")
      break
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  console.log(
    `📊 Collections migration complete: ${totalUpdated} total records updated`,
  )
  return totalUpdated
}

async function showStatus() {
  console.log("📋 Checking current status...")

  // Check collection_items needing migration
  const itemsResult = await db.execute(sql`
    SELECT COUNT(*) as count 
    FROM collection_items 
    WHERE deleted_at IS NULL 
      AND (
        status_message IS NULL 
        OR status_message = '' 
        OR upload_status IS NULL 
        OR upload_status = ''
        OR retry_count IS NULL
      )
  `)

  // Check collections needing migration
  const collectionsResult = await db.execute(sql`
    SELECT COUNT(*) as count 
    FROM collections 
    WHERE deleted_at IS NULL 
      AND (
        status_message IS NULL 
        OR status_message = '' 
        OR upload_status IS NULL 
        OR upload_status = ''
        OR retry_count IS NULL
      )
  `)

  const itemsCount = itemsResult[0]?.count || 0
  const collectionsCount = collectionsResult[0]?.count || 0

  console.log(`📊 Records needing migration:`)
  console.log(`   - Collection items: ${itemsCount}`)
  console.log(`   - Collections: ${collectionsCount}`)
  console.log("")

  return { itemsCount, collectionsCount }
}

async function main() {
  try {
    console.log("🚀 Status Fields Migration Script")
    console.log("=================================")

    // Show initial status
    const initialStatus = await showStatus()

    if (
      initialStatus.itemsCount === 0 &&
      initialStatus.collectionsCount === 0
    ) {
      console.log("✅ No records need migration!")
      process.exit(0)
    }

    // Migrate collection_items
    const itemsUpdated = await migrateCollectionItems()

    // Migrate collections
    const collectionsUpdated = await migrateCollections()

    // Show final status
    console.log("🔍 Verifying migration...")
    const finalStatus = await showStatus()

    if (finalStatus.itemsCount === 0 && finalStatus.collectionsCount === 0) {
      console.log("🎉 Migration completed successfully!")
      console.log(
        `📊 Total updated: ${itemsUpdated + collectionsUpdated} records`,
      )
    } else {
      console.log("⚠️  Some records still need migration:")
      console.log(`   - Collection items: ${finalStatus.itemsCount}`)
      console.log(`   - Collections: ${finalStatus.collectionsCount}`)
    }

    await connection.end()
    process.exit(0)
  } catch (error) {
    console.error("❌ Migration failed:", error)
    await connection.end()
    process.exit(1)
  }
}

// Run the migration
main()
