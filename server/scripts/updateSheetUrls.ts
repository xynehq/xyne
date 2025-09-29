import { db } from "@/db/client"
import { syncJobs } from "@/db/schema"
import { AuthType, Apps, DriveEntity } from "@/shared/types"
import { eq, and } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { google, sheets_v4, drive_v3 } from "googleapis"
import { createJwtClient } from "@/integrations/google/utils"
import { UpdateDocument, getDocumentOrNull } from "@/search/vespa"
import { fileSchema, type VespaFile } from "@xyne/vespa-ts/types"
import type { GoogleServiceAccount, TxnOrClient } from "@/types"
import { getSpreadsheet, listFiles } from "@/integrations/google"
import { DriveMime } from "@/integrations/google/utils"
import { getConnector, getConnectorByExternalId, getOAuthConnectorWithCredentials } from "@/db/connector"
import { getOAuthProviderByConnectorId } from "@/db/oauthProvider"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import type { OAuthCredentials } from "@/types"
import type { SelectOAuthProvider } from "@/db/schema/oauthProviders"
import { serviceAccountConnectorId } from "./googleConfig"
import config, { CLUSTER, NAMESPACE } from "@/config"
import { z } from "zod"
import pLimit from "p-limit"
import type { SelectConnector } from "@/db/schema"

const Logger = getLogger(Subsystem.Ingest)

// Concurrency limits
const USER_CONCURRENCY_LIMIT = 3 // Process 3 users concurrently
const SPREADSHEET_CONCURRENCY_LIMIT = 5 // Process 5 spreadsheets per user concurrently

// User schema for validation
const userSchema = z.object({
  email: z.string(),
})

// Database Operations
async function getUsersWithSyncJobs(
  trx: TxnOrClient,
  app: Apps,
  authType?: AuthType,
): Promise<Set<string>> {
  const whereConditions = [eq(syncJobs.app, app)]
  
  if (authType) {
    whereConditions.push(eq(syncJobs.authType, authType))
  }

  const jobs = await trx
    .select({ email: syncJobs.email })
    .from(syncJobs)
    .where(and(...whereConditions))

  const users = z.array(userSchema).parse(jobs)
  return new Set(users.map((user) => user.email))
}

// Get all users with Google Drive sync jobs (both OAuth and Service Account)
async function getAllUsersWithGoogleDriveJobs(
  trx: TxnOrClient,
): Promise<{ serviceAccountUsers: Set<string>; oauthUsers: Set<string> }> {
  const serviceAccountUsers = await getUsersWithSyncJobs(trx, Apps.GoogleDrive, AuthType.ServiceAccount)
  const oauthUsers = await getUsersWithSyncJobs(trx, Apps.GoogleDrive, AuthType.OAuth)
  
  return { serviceAccountUsers, oauthUsers }
}

async function getServiceAccountCredentials(): Promise<GoogleServiceAccount> {
  const serviceConnector = await getConnector(db, serviceAccountConnectorId)
  if (!serviceConnector) {
    throw new Error(
      `Service account connector not found: ${serviceAccountConnectorId}`,
    )
  }

  const connector = await getConnectorByExternalId(
    db,
    serviceConnector.externalId,
    serviceConnector.userId,
  )

  if (!connector?.credentials) {
    throw new Error(
      `Credentials not found for connector: ${serviceAccountConnectorId}`,
    )
  }

  return JSON.parse(connector.credentials as string)
}

// Client Management
interface ClientCache {
  jwtClients: Map<string, any>
  sheetsClients: Map<string, sheets_v4.Sheets>
}

class SheetsClientManager {
  private cache: ClientCache = {
    jwtClients: new Map(),
    sheetsClients: new Map(),
  }

  async initializeServiceAccount(
    userEmails: Set<string>,
    serviceAccount: GoogleServiceAccount,
  ): Promise<void> {
    Logger.info({ userCount: userEmails.size }, "Initializing Service Account Sheets clients")

    for (const email of userEmails) {
      try {
        const jwtClient = createJwtClient(serviceAccount, email)
        const sheetsClient = google.sheets({ version: "v4", auth: jwtClient })

        this.cache.jwtClients.set(email, jwtClient)
        this.cache.sheetsClients.set(email, sheetsClient)
      } catch (error) {
        Logger.warn({ email, error }, "Failed to create service account client for user")
      }
    }

    Logger.info(
      {
        clientsCreated: this.cache.sheetsClients.size,
      },
      "Service Account Sheets clients initialized",
    )
  }

  async initializeOAuth(
    oauthUsers: Set<string>,
  ): Promise<void> {
    Logger.info({ userCount: oauthUsers.size }, "Initializing OAuth Sheets clients")

    for (const email of oauthUsers) {
      try {
        // Get OAuth connector for this user
        const connector = await this.getOAuthConnectorForUser(email)
        if (!connector) {
          Logger.warn({ email }, "No OAuth connector found for user")
          continue
        }

        const oauth2Client = await this.createOAuthClient(connector)
        if (!oauth2Client) {
          Logger.warn({ email }, "Failed to create OAuth client for user")
          continue
        }

        const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client })

        this.cache.jwtClients.set(email, oauth2Client)
        this.cache.sheetsClients.set(email, sheetsClient)
      } catch (error) {
        Logger.warn({ email, error }, "Failed to create OAuth client for user")
      }
    }

    Logger.info(
      {
        clientsCreated: this.cache.sheetsClients.size,
      },
      "OAuth Sheets clients initialized",
    )
  }

  private async getOAuthConnectorForUser(email: string): Promise<SelectConnector | null> {
    try {
      // Get sync jobs for this user with OAuth auth type for Google Drive
      const syncJobs = await getAppSyncJobsByEmail(db, Apps.GoogleDrive, AuthType.OAuth, email)
      
      if (!syncJobs.length) {
        Logger.debug({ email }, "No OAuth sync jobs found for user")
        return null
      }

      // Get the connector from the first sync job
      const syncJob = syncJobs[0]
      const connector = await getOAuthConnectorWithCredentials(db, syncJob.connectorId)
      
      return connector
    } catch (error) {
      Logger.error({ email, error }, "Error getting OAuth connector for user")
      return null
    }
  }

  private async createOAuthClient(connector: SelectConnector): Promise<any | null> {
    try {
      const oauthTokens = (connector.oauthCredentials as OAuthCredentials).data
      const providers: SelectOAuthProvider[] = await getOAuthProviderByConnectorId(db, connector.id)

      if (!providers.length) {
        Logger.warn({ connectorId: connector.id }, "No OAuth provider found for connector")
        return null
      }

      const [googleProvider] = providers

      const oauth2Client = new google.auth.OAuth2({
        clientId: googleProvider.clientId!,
        clientSecret: googleProvider.clientSecret as string,
        redirectUri: `${config.host}/oauth/callback`,
      })

      oauth2Client.setCredentials({
        access_token: oauthTokens.access_token,
        refresh_token: oauthTokens.refresh_token,
      })

      return oauth2Client
    } catch (error) {
      Logger.error({ connectorId: connector.id, error }, "Error creating OAuth client")
      return null
    }
  }

  getSheetsClient(userEmail: string): sheets_v4.Sheets | null {
    return this.cache.sheetsClients.get(userEmail) || null
  }

  getJwtClient(userEmail: string): any | null {
    return this.cache.jwtClients.get(userEmail) || null
  }

  clear(): void {
    this.cache.jwtClients.clear()
    this.cache.sheetsClients.clear()
  }
}



// Fetch user's spreadsheets using listFiles (same as migration script)
const fetchUserSpreadsheets = async (jwtClient: any, userEmail: string, limit: number = 100): Promise<any[]> => {
  try {
    Logger.info(`Fetching spreadsheets using listFiles for user: ${userEmail}`)
    
    const allSpreadsheets: any[] = []
    let count = 0
    
    // Use the same listFiles approach as in the migration script
    const fileIterator = listFiles(jwtClient, undefined, undefined)

    for await (const sheetFiles of fileIterator) {
      if (sheetFiles.length === 0) {
        continue
      }
      
      // Filter for valid spreadsheet files (same as migration script)
      const validSpreadsheetFiles = sheetFiles.filter(file => 
        file.mimeType === DriveMime.Sheets ||
        file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimeType === 'text/csv'
      )
      
      allSpreadsheets.push(...validSpreadsheetFiles)
      count += validSpreadsheetFiles.length
      
      Logger.info(`Found ${validSpreadsheetFiles.length} spreadsheets in this batch for user: ${userEmail} (total: ${count})`)
      
      // Stop if we've reached the limit
      if (count >= limit) {
        Logger.info(`Reached limit of ${limit} spreadsheets for user: ${userEmail}`)
        break
      }
    }
    
    // Return up to the limit
    const result = allSpreadsheets.slice(0, limit)
    Logger.info(`Total spreadsheets found for user ${userEmail}: ${result.length}`)
    
    return result
  } catch (error) {
    Logger.error({ userEmail, error }, `Failed to fetch spreadsheets using listFiles for user: ${userEmail}`)
    return []
  }
}

// Process all sheets within a spreadsheet
const processSpreadsheetSheets = async (
  spreadsheet: drive_v3.Schema$File,
  userEmail: string,
  sheetsClient: sheets_v4.Sheets,
  jwtClient: any,
  processedDocIds: Map<string, boolean>,
  progressLogger?: { logProgress: (processed: number, updated: number, skipped: number, error: number, userEmail?: string) => void }
): Promise<{ processed: number; updated: number; skipped: number; error: number }> => {
  let processed = 0
  let updated = 0
  let skipped = 0
  let error = 0

  try {
    const spreadsheetId = spreadsheet.id
    Logger.info(`Processing spreadsheet: ${spreadsheet.name} (${spreadsheetId}) for user: ${userEmail}`)

    // Get spreadsheet details to fetch individual sheets
    const spreadsheetDetails = await getSpreadsheet(sheetsClient, spreadsheetId!, jwtClient, userEmail)
    
    if (!spreadsheetDetails || !spreadsheetDetails.data.sheets) {
      Logger.warn(`Could not fetch spreadsheet details for: ${spreadsheetId}`)
      return { processed: 0, updated: 0, skipped: 0, error: 1 }
    }

    const sheets = spreadsheetDetails.data.sheets
    Logger.info(`Found ${sheets.length} sheets in spreadsheet: ${spreadsheet.name}`)

    // Process each sheet within the spreadsheet
    for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
      const sheet = sheets[sheetIndex]
      const sheetId = sheet.properties?.sheetId
      const sheetTitle = sheet.properties?.title

      // Generate docId the same way as in index.ts: spreadsheetId_sheetIndex
      const docId = `${spreadsheetId}_${sheetIndex}`

      // Check if already processed
      if (processedDocIds.has(docId)) {
        Logger.debug(`Skipping already processed sheet: ${docId}`)
        skipped++
        continue
      }

      try {
        // Step 3: Get document from Vespa using docId
        const vespaSheet = await getDocumentOrNull(fileSchema, docId)
        
        if (!vespaSheet) {
          Logger.info(`Sheet not found in Vespa: "${spreadsheet.name}" / "${sheetTitle}" (${docId}) - sheet ${sheetIndex + 1} of ${sheets.length} - skipping (normal if sheet wasn't ingested)`)
          processedDocIds.set(docId, true)
          skipped++
          continue
        }

        processed++
        Logger.info(`Processing sheet: ${sheetTitle} (${docId}) from spreadsheet: ${spreadsheet.name}`)

        // Step 4: Update the document URL
        const vespaSheetData = vespaSheet.fields as VespaFile
        
        // Construct the new URL with the correct sheet ID
        const newUrl = sheetId 
          ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`
          : spreadsheet.webViewLink ?? ""
        
        // Check if URL needs updating
        const currentUrl = vespaSheetData.url || ""
        const needsUpdate = !currentUrl || newUrl !== currentUrl
        
        if (needsUpdate) {
          const updateReason = !currentUrl ? "Missing URL" : "URL change needed"
          Logger.info(`${updateReason} for sheet: ${vespaSheetData.title}`)
          Logger.info(`Old URL: ${currentUrl || "(missing)"}`)
          Logger.info(`New URL: ${newUrl}`)
          
          // Update the document in Vespa with new URL
          await UpdateDocument(fileSchema, docId, {
            url: newUrl,
            updatedAt: Date.now()
          })
          
          updated++
          Logger.info(`Successfully updated URL for sheet: ${vespaSheetData.title}`)
        } else {
          Logger.info(`No URL change needed for sheet: ${vespaSheetData.title}`)
          skipped++
        }

        // Mark as processed
        processedDocIds.set(docId, true)

        // Log progress
        if (progressLogger) {
          progressLogger.logProgress(1, needsUpdate ? 1 : 0, needsUpdate ? 0 : 1, 0, userEmail)
        }

      } catch (sheetError) {
        Logger.error({ docId, userEmail, error: sheetError }, `Failed to process sheet: ${docId}`)
        processedDocIds.set(docId, true) // Mark as processed to avoid retry
        error++
      }
    }

    return { processed, updated, skipped, error }

  } catch (spreadsheetError) {
    Logger.error({ spreadsheetId: spreadsheet.id, userEmail, error: spreadsheetError }, `Failed to process spreadsheet: ${spreadsheet.id}`)
    return { processed: 0, updated: 0, skipped: 0, error: 1 }
  }
}

// Process sheet URL updates for a specific user - Google API first approach
const processUserSheetUrls = async (
  userEmail: string,
  clientManager: SheetsClientManager,
  processedDocIds: Map<string, boolean>,
  progressLogger?: { logProgress: (processed: number, updated: number, skipped: number, error: number, userEmail?: string) => void }
): Promise<{ processed: number; updated: number; skipped: number; error: number }> => {
  let processedForUser = 0
  let updatedForUser = 0
  let skippedForUser = 0
  let errorForUser = 0

  const sheetsClient = clientManager.getSheetsClient(userEmail)

  if (!sheetsClient) {
    Logger.warn({ userEmail }, "No Sheets client found for user")
    return { processed: 0, updated: 0, skipped: 0, error: 1 }
  }

  Logger.info(`Fetching spreadsheets from Google API for user: ${userEmail}`)

  try {
    // Step 1: Fetch spreadsheets using listFiles (same as migration script)
    const jwtClient = clientManager.getJwtClient(userEmail)
    if (!jwtClient) {
      Logger.warn({ userEmail }, "No JWT client found for user")
      return { processed: 0, updated: 0, skipped: 0, error: 1 }
    }
    
    const googleSheets = await fetchUserSpreadsheets(jwtClient, userEmail)
    
    if (googleSheets.length === 0) {
      Logger.info(`No spreadsheets found for user: ${userEmail}`)
      return { processed: 0, updated: 0, skipped: 0, error: 0 }
    }

    Logger.info(`Found ${googleSheets.length} spreadsheets for user: ${userEmail}`)

    // Step 2: Process each spreadsheet and its sheets
    const sheetLimit = pLimit(SPREADSHEET_CONCURRENCY_LIMIT)
    
    const sheetPromises = googleSheets.map(spreadsheet =>
      sheetLimit(async () => {
        return await processSpreadsheetSheets(
          spreadsheet,
          userEmail,
          sheetsClient,
          jwtClient,
          processedDocIds,
          progressLogger
        )
      })
    )

    const results = await Promise.allSettled(sheetPromises)
    
    // Aggregate results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { processed, updated, skipped, error } = result.value
        processedForUser += processed
        updatedForUser += updated
        skippedForUser += skipped
        errorForUser += error
      } else {
        Logger.error(
          { userEmail, error: result.reason },
          `Failed to process spreadsheet for user: ${userEmail}`
        )
        errorForUser++
      }
    }

    Logger.info(`Completed URL processing for user: ${userEmail}. Processed: ${processedForUser} sheets, Updated: ${updatedForUser} sheets, Skipped: ${skippedForUser} sheets, Errors: ${errorForUser}`)
    
    return { 
      processed: processedForUser, 
      updated: updatedForUser, 
      skipped: skippedForUser, 
      error: errorForUser 
    }

  } catch (error) {
    Logger.error({ userEmail, error }, `Failed to fetch spreadsheets for user: ${userEmail}`)
    return { processed: 0, updated: 0, skipped: 0, error: 1 }
  }
}

// Main URL update function
const updateGoogleSheetUrls = async (): Promise<boolean> => {
  Logger.info("Starting Google Sheets URL update script.")

  try {
    // Get users with Google Drive sync jobs (both Service Account and OAuth)
    const { serviceAccountUsers, oauthUsers } = await getAllUsersWithGoogleDriveJobs(db)
    
    const totalUsers = serviceAccountUsers.size + oauthUsers.size
    if (totalUsers === 0) {
      Logger.info("No users with Google Drive sync jobs found.")
      return true
    }

    Logger.info(`Found ${totalUsers} users with Google Drive sync jobs (Service Account: ${serviceAccountUsers.size}, OAuth: ${oauthUsers.size}).`)

    // Initialize deduplication map to track processed documents
    const processedDocIds = new Map<string, boolean>()
    Logger.info("Initialized document deduplication tracking - using Google API first approach")

    // Initialize client manager
    const clientManager = new SheetsClientManager()
    
    // Initialize Service Account clients if there are any
    if (serviceAccountUsers.size > 0) {
      try {
        const serviceAccount = await getServiceAccountCredentials()
        await clientManager.initializeServiceAccount(serviceAccountUsers, serviceAccount)
        Logger.info(`Initialized ${serviceAccountUsers.size} Service Account clients`)
      } catch (error) {
        Logger.error(error, "Failed to initialize Service Account clients")
        // Continue with OAuth users even if Service Account fails
      }
    }
    
    // Initialize OAuth clients if there are any
    if (oauthUsers.size > 0) {
      try {
        await clientManager.initializeOAuth(oauthUsers)
        Logger.info(`Initialized OAuth clients`)
      } catch (error) {
        Logger.error(error, "Failed to initialize OAuth clients")
        // Continue even if OAuth fails
      }
    }

    let totalProcessed = 0
    let totalUpdated = 0
    let totalSkipped = 0
    let totalErrors = 0
    
    // Shared counter for global progress tracking
    let globalDocumentCount = 0
    const progressLogger = {
      logProgress: (processed: number, updated: number, skipped: number, error: number, userEmail?: string) => {
        globalDocumentCount += processed
        totalProcessed += processed
        totalUpdated += updated
        totalSkipped += skipped
        totalErrors += error
        
        // Log progress every 100 documents
        if (globalDocumentCount > 0 && globalDocumentCount % 100 === 0) {
          const userInfo = userEmail ? ` for ${userEmail}` : " across all users"
          Logger.info(
            { 
              globalDocumentCount, 
              totalProcessed, 
              totalUpdated, 
              totalSkipped, 
              totalErrors,
              userEmail 
            },
            `Progress update${userInfo}: Processed ${globalDocumentCount} documents (Totals: Processed: ${totalProcessed}, Updated: ${totalUpdated}, Skipped: ${totalSkipped}, Errors: ${totalErrors})`
          )
        }
      }
    }

    // Combine all users for processing
    const allUsers = Array.from(new Set([...serviceAccountUsers, ...oauthUsers]))
    Logger.info(`Processing ${allUsers.length} total users in batches of ${USER_CONCURRENCY_LIMIT}`)

    // Process users in batches of 3
    const userBatches = []
    for (let i = 0; i < allUsers.length; i += USER_CONCURRENCY_LIMIT) {
      userBatches.push(allUsers.slice(i, i + USER_CONCURRENCY_LIMIT))
    }

    Logger.info(`Created ${userBatches.length} user batches`)

    let batchNumber = 0
    const userResults: Array<{ userEmail: string; success: boolean; authType: string; stats: any }> = []

    // Process each batch sequentially
    for (const userBatch of userBatches) {
      batchNumber++
      Logger.info(`Processing user batch ${batchNumber}/${userBatches.length} with ${userBatch.length} users: [${userBatch.join(', ')}]`)

      // Create concurrency limiter for this batch
      const batchLimit = pLimit(USER_CONCURRENCY_LIMIT)

      // Process users in this batch concurrently
      const batchPromises = userBatch.map(userEmail =>
        batchLimit(async () => {
          try {
            const authType = serviceAccountUsers.has(userEmail) ? 'Service Account' : 'OAuth'
            Logger.info(`Processing ${authType} user: ${userEmail} (batch ${batchNumber})`)
            
            const stats = await processUserSheetUrls(userEmail, clientManager, processedDocIds, progressLogger)
            return { userEmail, success: true, authType, stats }
          } catch (error) {
            Logger.error(
              { userEmail, error },
              `Failed to process sheet URLs for user: ${userEmail}. Error: ${error instanceof Error ? error.message : String(error)}`
            )
            return { 
              userEmail, 
              success: false, 
              authType: serviceAccountUsers.has(userEmail) ? 'Service Account' : 'OAuth',
              stats: { processed: 0, updated: 0, skipped: 0, error: 1 }
            }
          }
        })
      )

      const batchResults = await Promise.allSettled(batchPromises)
      
      // Collect results from this batch
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          userResults.push(result.value)
        } else {
          Logger.error(`Batch ${batchNumber} user processing failed:`, result.reason)
          userResults.push({
            userEmail: 'unknown',
            success: false,
            authType: 'unknown',
            stats: { processed: 0, updated: 0, skipped: 0, error: 1 }
          })
        }
      }

      Logger.info(`Completed batch ${batchNumber}/${userBatches.length}. Processed documents so far: ${processedDocIds.size}`)
      
      // Small delay between batches to avoid overwhelming systems
      if (batchNumber < userBatches.length) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    
    // Aggregate final statistics
    let failedUsers = 0
    let successfulServiceAccount = 0
    let successfulOAuth = 0
    let failedServiceAccount = 0
    let failedOAuth = 0

    // Aggregate totals from all users
    totalProcessed = 0
    totalUpdated = 0
    totalSkipped = 0
    totalErrors = 0

    for (const result of userResults) {
      if (result.success) {
        if (result.authType === 'Service Account') {
          successfulServiceAccount++
        } else {
          successfulOAuth++
        }
        // Add to totals
        if (result.stats) {
          totalProcessed += result.stats.processed || 0
          totalUpdated += result.stats.updated || 0
          totalSkipped += result.stats.skipped || 0
          totalErrors += result.stats.error || 0
        }
      } else {
        failedUsers++
        if (result.authType === 'Service Account') {
          failedServiceAccount++
        } else {
          failedOAuth++
        }
        if (result.stats) {
          totalErrors += result.stats.error || 1
        }
      }
    }
    
    Logger.info(`User processing summary: ${allUsers.length} total users`)
    Logger.info(`Service Account - Successful: ${successfulServiceAccount}, Failed: ${failedServiceAccount}`)
    Logger.info(`OAuth - Successful: ${successfulOAuth}, Failed: ${failedOAuth}`)
    Logger.info(`Overall - Total failed: ${failedUsers}`)
    Logger.info(`Document deduplication: ${processedDocIds.size} unique documents processed`)

    // Clean up clients
    clientManager.clear()

    Logger.info(`Google Sheets URL update script completed. Total processed: ${totalProcessed} sheets, Total updated: ${totalUpdated} sheets, Total skipped: ${totalSkipped} sheets, Total errors: ${totalErrors}`)
    
    return true
    
  } catch (error) {
    Logger.error(
      error,
      `Failed to complete URL update: ${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  }
}

// Execute the URL update
async function runUrlUpdate() {
  try {
    Logger.info("Starting URL update process for both OAuth and Service Account users...")
    
    const result = await updateGoogleSheetUrls()
    if (result) {
      Logger.info("URL update completed successfully.")
      await cleanup()
      process.exit(0)
    } else {
      Logger.error("URL update failed.")
      await cleanup()
      process.exit(1)
    }
  } catch (error) {
    Logger.error(error, "Unexpected error during URL update.")
    await cleanup()
    process.exit(1)
  }
}

// Cleanup function to ensure proper resource disposal
async function cleanup() {
  try {
    Logger.info("Cleaning up resources...")
    
    // Close database connections
    if (db && db.$client && typeof db.$client.end === 'function') {
      await db.$client.end()
      Logger.info("Database connection closed")
    }
    
    // Allow some time for cleanup
    await new Promise(resolve => setTimeout(resolve, 500))
    
    Logger.info("Cleanup completed")
    
  } catch (error) {
    Logger.error(error, "Error during cleanup")
  }
}

Logger.info("Google Sheets URL Update Script starting...")
Logger.info("Processing both OAuth and Service Account authentication types")

// Add timeout to force exit if script hangs
const SCRIPT_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const timeoutId = setTimeout(() => {
  Logger.error("Script timed out after 30 minutes, forcing exit...")
  process.exit(1)
}, SCRIPT_TIMEOUT)

// Clear timeout on successful completion
runUrlUpdate()
  .then(() => {
    clearTimeout(timeoutId)
  })
  .catch(error => {
    clearTimeout(timeoutId)
    Logger.error("Script failed with error:", error)
    process.exit(1)
  })

// Handle process signals for graceful shutdown
process.on('SIGINT', async () => {
  Logger.info("Received SIGINT, shutting down gracefully...")
  clearTimeout(timeoutId)
  await cleanup()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  Logger.info("Received SIGTERM, shutting down gracefully...")
  clearTimeout(timeoutId)
  await cleanup()
  process.exit(0)
})