import { fetchEmailsAndAttachments, createJwtClient, type EmailFilters } from '../integrations/google/gmail-fetcher';
import type { GoogleServiceAccount } from '@/types';
import * as fs from 'fs';
import * as path from 'path';

// --- Configuration ---
const SERVICE_ACCOUNT_FILE = 'service-account.json';
const USER_EMAIL_TO_INGEST = ''; // <--- REPLACE WITH YOUR GMAIL ADDRESS

// --- Filters to Apply ---
const filters: EmailFilters = {
  fromEmail: '',
  // subject: 'Your Report',
  // startDate: '2024-01-01',
  // endDate: '2024-01-31',
};

// --- Main Test Execution ---
const runTest = async () => {
  const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);

  if (!fs.existsSync(serviceAccountPath)) {
    console.error(`Error: Service account key file not found at ${serviceAccountPath}`);
    console.error('Please place your service account JSON key in the same directory.');
    process.exit(1);
  }

  const serviceAccountKey: GoogleServiceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

  console.log(`Starting email fetch for ${USER_EMAIL_TO_INGEST}...`);

  try {
    const jwtClient = createJwtClient(serviceAccountKey, USER_EMAIL_TO_INGEST);
    const fetchedData = await fetchEmailsAndAttachments(jwtClient, filters);

    console.log('\n--- Fetching Complete ---');
    if (fetchedData.length > 0) {
      console.log(`Successfully fetched data for ${fetchedData.length} email(s).`);
      // Log the details of the first email as an example
      console.log('\n--- Example of First Fetched Email ---');
      const firstEmail = fetchedData[0];
      console.log(`Subject: ${firstEmail.subject}`);
      console.log(`From: ${firstEmail.from}`);
      console.log(`Date: ${firstEmail.date}`);
      console.log(`Attachment Paths: ${firstEmail.attachmentPaths.join(', ')}`);
      console.log(`Email Body (first 200 chars): ${firstEmail.emailBody.substring(0, 200)}...`);
      console.log('-------------------------------------\n');

    } else {
      console.log('No emails were found that matched the specified criteria.');
    }

  } catch (error) {
    console.error('\n--- An error occurred during the fetch process ---');
    console.error(error);
  }
};

runTest();
