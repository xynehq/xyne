import { db } from "@/db/client"
import { oauthProviders, selectProviderSchema, type SelectOAuthProvider } from "@/db/schema"
import { getLogger } from "@/logger"
import { Apps } from "@/search/types"
import { Subsystem, type TxnOrClient } from "@/types"
import fs from "fs"
import path from "path"

const Logger = getLogger(Subsystem.Db).child({ module: "extract-oauth-providers" })

interface OAuthProviderBackup {
  id: number
  workspaceId: number
  userId: number
  externalId: string
  workspaceExternalId: string
  connectorId: number
  clientId: string | null
  clientSecret: string | null // already decrypted by Drizzle
  oauthScopes: string[]
  app: string
  isGlobal: boolean | null
  createdAt: Date
  updatedAt: Date
}

interface ExtractionResult {
  extractedAt: string
  totalProviders: number
  oauthProviders: OAuthProviderBackup[]
  encryptionKeys: {
    encryptionKey: string
    serviceAccountEncryptionKey: string
  }
}

export const getAllOAuthProviders = async (
  trx: TxnOrClient,
): Promise<SelectOAuthProvider[]> => {
  const res = await trx
    .select()
    .from(oauthProviders)
    .limit(150)
    
  if (res.length) {
    let parsedRes: SelectOAuthProvider[] = []
    for(const item of res){
      const parseResult = selectProviderSchema.safeParse(item)
      if (parseResult.success) {
        parsedRes.push(parseResult.data)
      }
    }
    
    return parsedRes
  } else {
    Logger.warn("No OAuth providers found in database")
    return []
  }
}

async function extractOAuthProviders(): Promise<void> {
  try {
    Logger.info("Starting OAuth provider extraction process...")

    // Validate environment variables
    const encryptionKey = process.env.ENCRYPTION_KEY
    const serviceAccountEncryptionKey = process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY

    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY environment variable is not set")
    }
    if (!serviceAccountEncryptionKey) {
      throw new Error("SERVICE_ACCOUNT_ENCRYPTION_KEY environment variable is not set")
    }

    Logger.info("Fetching all OAuth providers from database...")

    let result: any = []
    try {
      result = await getAllOAuthProviders(db)
      console.log(result)
    } catch(error) {
      console.log(error)
    }

    const allProviders = result

    Logger.info(`Found ${allProviders.length} OAuth providers to extract`)

    const providersBackup: OAuthProviderBackup[] = allProviders.map((provider: SelectOAuthProvider) => ({
      id: provider.id,
      workspaceId: provider.workspaceId,
      userId: provider.userId,
      externalId: provider.externalId,
      workspaceExternalId: provider.workspaceExternalId,
      connectorId: provider.connectorId,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret, // already decrypted
      oauthScopes: provider.oauthScopes,
      app: provider.app,
      isGlobal: provider.isGlobal,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    }))

    // Prepare extraction result
    const extractionResult: ExtractionResult = {
      extractedAt: new Date().toISOString(),
      totalProviders: providersBackup.length,
      oauthProviders: providersBackup,
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
    const filename = `oauth-providers-backup-${timestamp}.json`
    const filepath = path.join(outputDir, filename)

    // Write to JSON file
    fs.writeFileSync(filepath, JSON.stringify(extractionResult, null, 2))

    Logger.info(`Successfully extracted ${providersBackup.length} OAuth providers`)
    Logger.info(`Backup saved to: ${filepath}`)

    console.log("\n=== EXTRACTION COMPLETE ===")
    console.log(`Total OAuth providers extracted: ${providersBackup.length}`)
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
  extractOAuthProviders()
    .then(() => {
      console.log("Extraction completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      console.error("Extraction failed:", error)
      process.exit(1)
    })
}

export { extractOAuthProviders }
