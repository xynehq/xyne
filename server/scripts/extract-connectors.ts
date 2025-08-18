import { db } from "@/db/client"

import { connectors, selectConnectorSchema, type SelectConnector } from "@/db/schema"
import { NoConnectorsFound } from "@/errors"
import { getLogger } from "@/logger"
import { Apps } from "@/search/types"
import { AuthType } from "@/shared/types"
import { Subsystem, type TxnOrClient } from "@/types"
import fs from "fs"
import path from "path"

const Logger = getLogger(Subsystem.Db).child({ module: "extract-connectors" })

interface ConnectorBackup {
  id: number
  workspaceId: number
  userId: number
  externalId: string
  workspaceExternalId: string
  name: string
  type: string
  authType: string
  app: string
  config: any
  credentials: string | null // already decrypted by Drizzle
  subject: string | null // already decrypted by Drizzle
  oauthCredentials: string | null // already decrypted by Drizzle
  apiKey: string | null // already decrypted by Drizzle
  status: string
  state: any
  createdAt: Date
  updatedAt: Date
}

interface ExtractionResult {
  extractedAt: string
  totalConnectors: number
  connectors: ConnectorBackup[]
  encryptionKeys: {
    encryptionKey: string
    serviceAccountEncryptionKey: string
  }
}

export const getAllConnector = async (
  trx: TxnOrClient,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .limit(150)
    
    
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      
      throw new NoConnectorsFound({
        message: `Could not parse connector data `,
      })
    }
    return parsedRes.data
  } else {
    
    throw new NoConnectorsFound({
      message: `Connector not found `,
    })
  }
}

async function extractConnectors(): Promise<void> {
  try {
    Logger.info("Starting connector extraction process...")

    // Validate environment variables
    const encryptionKey = process.env.ENCRYPTION_KEY
    const serviceAccountEncryptionKey = process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY

    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY environment variable is not set")
    }
    if (!serviceAccountEncryptionKey) {
      throw new Error("SERVICE_ACCOUNT_ENCRYPTION_KEY environment variable is not set")
    }

    Logger.info("Fetching all connectors from database...")

    // Fetch raw data without automatic decryption by using raw SQL
    let result:any = []
try{
    result =await getAllConnector(db)
    console.log(result)

}
catch(error){
  console.log(error)
}
    const allConnectors = [result]

    Logger.info(`Found ${allConnectors.length} connectors to extract`)

    const connectorsBackup: ConnectorBackup[] = allConnectors.map((connector:SelectConnector) => ({
      id: connector.id,
      workspaceId: connector.workspaceId,
      userId: connector.userId,
      externalId: connector.externalId,
      workspaceExternalId: connector.workspaceExternalId,
      name: connector.name,
      type: connector.type,
      authType: connector.authType,
      app: connector.app,
      config: connector.config,
      credentials: connector.credentials, // already decrypted
      subject: connector.subject, // already decrypted
      oauthCredentials: connector.oauthCredentials, // already decrypted
      apiKey: connector.apiKey, // already decrypted
      status: connector.status,
      state: connector.state,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    }))

    // Prepare extraction result
    const extractionResult: ExtractionResult = {
      extractedAt: new Date().toISOString(),
      totalConnectors: connectorsBackup.length,
      connectors: connectorsBackup,
      encryptionKeys: {
        encryptionKey: encryptionKey,
        serviceAccountEncryptionKey: serviceAccountEncryptionKey,
      }
    }

    // Create output directory if it doesn't exist
    const outputDir = path.join(process.cwd(), "backups")
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `connectors-backup-${timestamp}.json`
    const filepath = path.join(outputDir, filename)

    // Write to JSON file
    fs.writeFileSync(filepath, JSON.stringify(extractionResult, null, 2))

    Logger.info(`Successfully extracted ${connectorsBackup.length} connectors`)
    Logger.info(`Backup saved to: ${filepath}`)

    console.log("\n=== EXTRACTION COMPLETE ===")
    console.log(`Total connectors extracted: ${connectorsBackup.length}`)
    console.log(`Backup file: ${filepath}`)
    console.log(`Extraction timestamp: ${extractionResult.extractedAt}`)

  } catch (error) {
    Logger.error(`Extraction failed: ${error}`)
    console.error("Extraction failed:", error)
    process.exit(1)
  }
}

// Run the extraction if this script is executed directly
if (require.main === module) {
  extractConnectors()
    .then(() => {
      console.log("Extraction completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      console.error("Extraction failed:", error)
      process.exit(1)
    })
}

export { extractConnectors }
