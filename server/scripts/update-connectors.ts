import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
 // Update this import path

 // Update this import path
import { db, updateConnector } from '@/db/connector';
import type { SelectConnector } from '../db/schema';
import type { TxnOrClient } from '@/types';
import type { Apps } from '@/search/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - update these values as needed
const BACKUP_FILE_PATH = '../backups/connectors-backup-2025-08-19T07-12-31-490Z.json';

interface Connector {
  id: number;
  workspaceId: number;
  userId: number;
  externalId: string;
  workspaceExternalId: string;
  name: string;
  type: string;
  authType: string;
  app: Apps;
  config: Record<string, any>;
  credentials: any;
  subject: string;
  oauthCredentials: string | null;
  apiKey: string | null;
  status: string;
  state: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

interface BackupData {
  extractedAt: string;
  totalConnectors: number;
  connectors: Connector[];
  encryptionKeys: {
    encryptionKey: string;
    serviceAccountEncryptionKey: string;
  };
}

async function updateConnectorFromBackup(
  trx: TxnOrClient,
  connector: Connector
): Promise<SelectConnector> {
  try {
    const updateData: Partial<SelectConnector> = {
      workspaceId: connector.workspaceId,
      userId: connector.userId,
      externalId: connector.externalId,
      workspaceExternalId: connector.workspaceExternalId,
      name: connector.name,
      type: connector.type,
      authType: connector.authType,
      app: connector.app,
      config: connector.config,
      credentials: connector.credentials,
      subject: connector.subject,
      oauthCredentials: connector.oauthCredentials,
      apiKey: connector.apiKey,
      status: connector.status,
      state: connector.state,
      // Note: createdAt and updatedAt will be handled by the database
    };

    const updatedConnector = await updateConnector(trx, connector.id, updateData);
    console.log(`✅ Successfully updated connector ID: ${connector.id} (${connector.name})`);
    return updatedConnector;
  } catch (error) {
    console.error(`❌ Error updating connector ID: ${connector.id}:`, (error as Error).message);
    throw error;
  }
}

async function updateConnectorsFromBackup(): Promise<void> {
  try {
    // Read the backup file
    const backupFilePath = path.resolve(__dirname, BACKUP_FILE_PATH);
    const fileContent = fs.readFileSync(backupFilePath, 'utf8');
    const backupData: BackupData = JSON.parse(fileContent);

    console.log(`📄 Loaded backup file: ${BACKUP_FILE_PATH}`);
    console.log(`📊 Total connectors found: ${backupData.totalConnectors}`);
    console.log(`🕒 Backup extracted at: ${backupData.extractedAt}`);

    // Process each connector
    const connectors = backupData.connectors || [];
    
    if (connectors.length === 0) {
      console.log('⚠️  No connectors found in backup file');
      return;
    }

    console.log('\n🔄 Starting connector updates...\n');

    // Use database transaction for all updates
    await db.transaction(async (trx) => {
      for (const connector of connectors) {
        console.log(`🔄 Updating connector: ${connector.name} (ID: ${connector.id})`);
        await updateConnectorFromBackup(trx, connector);
        
        // Add a small delay between updates
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    console.log('\n✅ Connector update process completed');
    process.exit(0)
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error(`❌ Backup file not found: ${BACKUP_FILE_PATH}`);
    } else if (error instanceof SyntaxError) {
      console.error('❌ Invalid JSON in backup file:', error.message);
    } else {
      console.error('❌ Error processing backup file:', (error as Error).message);
    }
    process.exit(1)
  }
}

// Run the script

  updateConnectorsFromBackup();

