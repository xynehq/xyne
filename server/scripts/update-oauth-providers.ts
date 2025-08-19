import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { db } from '@/db/client';
import { createOAuthProvider } from '@/db/oauthProvider';
import type { SelectOAuthProvider, InsertOAuthProvider } from '@/db/schema';
import type { TxnOrClient } from '@/types';
import { oauthProviders } from '@/db/schema';
import { eq } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - update these values as needed
const BACKUP_FILE_PATH = '../backups/oauth-providers-backup-2025-08-19T09-09-21-004Z.json';

interface OAuthProvider {
  id: number;
  workspaceId: number;
  userId: number;
  externalId: string;
  workspaceExternalId: string;
  connectorId: number;
  clientId: string | null;
  clientSecret: string | null;
  oauthScopes: string[];
  app: string;
  isGlobal: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface BackupData {
  extractedAt: string;
  totalProviders: number;
  oauthProviders: OAuthProvider[];
  encryptionKeys: {
    encryptionKey: string;
    serviceAccountEncryptionKey: string;
  };
}

async function updateOAuthProvider(
  trx: TxnOrClient,
  providerId: number,
  updateData: Partial<SelectOAuthProvider>
): Promise<SelectOAuthProvider> {
  try {
    const updated = await trx
      .update(oauthProviders)
      .set(updateData)
      .where(eq(oauthProviders.id, providerId))
      .returning();

    if (updated.length === 0) {
      throw new Error(`OAuth provider with ID ${providerId} not found`);
    }

    return updated[0];
  } catch (error) {
    throw new Error(`Failed to update OAuth provider: ${(error as Error).message}`);
  }
}

async function updateOAuthProviderFromBackup(
  trx: TxnOrClient,
  provider: OAuthProvider
): Promise<void> {
  try {
    // Check if provider exists

    
      // Update existing provider
      const updateData: Partial<SelectOAuthProvider> = {
        workspaceId: provider.workspaceId,
        userId: provider.userId,
        externalId: provider.externalId,
        workspaceExternalId: provider.workspaceExternalId,
        connectorId: provider.connectorId,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        oauthScopes: provider.oauthScopes,
        app: provider.app as any,
        isGlobal: provider.isGlobal,
      }

      await updateOAuthProvider(trx, provider.id, updateData);
      console.log(`✅ Successfully updated OAuth provider ID: ${provider.id} (App: ${provider.app})`);
    }
   catch (error) {
    console.error(`❌ Error processing OAuth provider ID: ${provider.id}:`, (error as Error).message);
    throw error;
  }
}

async function updateOAuthProvidersFromBackup(): Promise<void> {
  try {
    // Read the backup file
    const backupFilePath = path.resolve(__dirname, BACKUP_FILE_PATH);
    const fileContent = fs.readFileSync(backupFilePath, 'utf8');
    const backupData: BackupData = JSON.parse(fileContent);

    console.log(`📄 Loaded backup file: ${BACKUP_FILE_PATH}`);
    console.log(`📊 Total OAuth providers found: ${backupData.totalProviders}`);
    console.log(`🕒 Backup extracted at: ${backupData.extractedAt}`);

    // Process each OAuth provider
    const providers = backupData.oauthProviders || [];
    
    if (providers.length === 0) {
      console.log('⚠️  No OAuth providers found in backup file');
      return;
    }

    console.log('\n🔄 Starting OAuth provider updates...\n');

    // Use database transaction for all updates
    await db.transaction(async (trx) => {
      for (const provider of providers) {
        console.log(`🔄 Processing OAuth provider: ${provider.app} (ID: ${provider.id})`);
        await updateOAuthProviderFromBackup(trx, provider);
        
        // Add a small delay between updates
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    console.log('\n✅ OAuth provider update process completed');

  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error(`❌ Backup file not found: ${BACKUP_FILE_PATH}`);
    } else if (error instanceof SyntaxError) {
      console.error('❌ Invalid JSON in backup file:', error.message);
    } else {
      console.error('❌ Error processing backup file:', (error as Error).message);
    }
  }
}

// Run the script
updateOAuthProvidersFromBackup();
