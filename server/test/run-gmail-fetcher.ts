import { fetchEmailsAndAttachments, type EmailFilters } from '../integrations/google/gmail-fetcher';
import { createJwtClient } from '../integrations/google/gmail-worker';
import type { GoogleServiceAccount } from '@/types';
import { getLogger } from '@/logger';
import { Subsystem } from '@/types';
import { db } from '../db/client';
import { getConnectorByAppAndEmailId } from '../db/connector';
import { Apps, AuthType } from '@/shared/types';

const Logger = getLogger(Subsystem.Integrations);

// --- Configuration ---
const USER_EMAIL_TO_INGEST = 'admin@topabcd.com'; // <--- REPLACE WITH YOUR GMAIL ADDRESS

// --- Filters to Apply ---
const filters: EmailFilters = {
  fromEmail: 'yashdagacsef31@gmail.com',
  // subject: 'Your Report',
  // startDate: '2024-01-01',
  // endDate: '2024-01-31',
};

// --- New Function to Fetch Service Account and Run Gmail Fetch ---
const fetchGmailForUser = async (userEmail: string, emailFilters: EmailFilters) => {
  Logger.info(`Starting email fetch for ${userEmail}...`);

  try {
    const connector = await getConnectorByAppAndEmailId(
      db, 
      Apps.Gmail, 
      AuthType.ServiceAccount, 
      userEmail
    );

    if (!connector.credentials) {
      Logger.error(`Connector for user: ${userEmail} does not have a service account.`);
      process.exit(1);
    }

    // The credentials are automatically decrypted by the custom type when fetched from DB
    const serviceAccountKey: GoogleServiceAccount = JSON.parse(connector.credentials as string);

    const jwtClient = createJwtClient(serviceAccountKey, userEmail);
    const fetchedData = await fetchEmailsAndAttachments(jwtClient, emailFilters);

    Logger.info('\n--- Fetching Complete ---');
    if (fetchedData.length > 0) {
      Logger.info(`Successfully fetched data for ${fetchedData.length} email(s).`);
      // Log the details of the first email as an example
      Logger.info('\n--- Example of First Fetched Email ---');
      const firstEmail = fetchedData[0];
      Logger.info(`Subject: ${firstEmail.subject}`);
      Logger.info(`From: ${firstEmail.from}`);
      Logger.info(`Date: ${firstEmail.date}`);
      Logger.info(`Attachment Paths: ${firstEmail.attachmentPaths.join(', ')}`);
      Logger.info(`Email Body (first 200 chars): ${firstEmail.emailBody.substring(0, 200)}...`);
      Logger.info('-------------------------------------\n');
    } else {
      Logger.info('No emails were found that matched the specified criteria.');
    }
  } catch (error) {
    Logger.error('\n--- An error occurred during the fetch process ---');
    Logger.error(error);
  }
};

// --- Main Test Execution ---
const runTest = async () => {
  await fetchGmailForUser(USER_EMAIL_TO_INGEST, filters);
};

runTest();
