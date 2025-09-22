import { fetchEmailsAndAttachments, type EmailFilters } from '../integrations/google/gmail-fetcher';
import { createJwtClient } from '../integrations/google/gmail-worker';
import type { GoogleServiceAccount } from '@/types';
import * as fs from 'fs';
import { getLogger } from '@/logger';
import { Subsystem } from '@/types';

const Logger = getLogger(Subsystem.Integrations);
import * as path from 'path';

// --- Configuration ---
const SERVICE_ACCOUNT_FILE = 'service-account.json';
const USER_EMAIL_TO_INGEST = 'admin@topabcd.com'; // <--- REPLACE WITH YOUR GMAIL ADDRESS

// --- Filters to Apply ---
const filters: EmailFilters = {
  fromEmail: 'yashdagacsef31@gmail.com',
  // subject: 'Your Report',
  // startDate: '2024-01-01',
  // endDate: '2024-01-31',
};

// --- Main Test Execution ---
const runTest = async () => {
  const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);

  if (!fs.existsSync(serviceAccountPath)) {
    Logger.error(`Error: Service account key file not found at ${serviceAccountPath}`);
    Logger.error('Please place your service account JSON key in the same directory.');
    process.exit(1);
  }

  const serviceAccountKey: GoogleServiceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

  Logger.info(`Starting email fetch for ${USER_EMAIL_TO_INGEST}...`);

  try {
    const jwtClient = createJwtClient(serviceAccountKey, USER_EMAIL_TO_INGEST);
    const fetchedData = await fetchEmailsAndAttachments(jwtClient, filters);

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

runTest();
