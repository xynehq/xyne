import { google, gmail_v1 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseEmailBody } from './gmail/quote-parser';
import type { GoogleServiceAccount } from '@/types';

const htmlToText = require('html-to-text');

// --- Interfaces and Types ---
export interface EmailFilters {
  fromEmail?: string;
  subject?: string;
  startDate?: string;
  endDate?: string;
}

export interface FetchedEmailData {
  emailBody: string;
  attachmentPaths: string[];
  subject: string;
  from: string;
  date: string;
}

// --- Reusable Helper Functions (from gmail-worker) ---

export const createJwtClient = (serviceAccountKey: GoogleServiceAccount, subject: string): JWT => {
  return new JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject,
  });
};

const getBody = (payload: gmail_v1.Schema$MessagePart | undefined): string => {
  let body = '';
  if (!payload) return body;

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        body += htmlToText.convert(html, { wordwrap: 130 }) + '\n';
      }
    }
  } else if (payload.body?.data) {
    const data = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    if (payload.mimeType === 'text/html') {
      return htmlToText.convert(data, { wordwrap: 130 });
    }
    return data;
  }

  return parseEmailBody(body).replace(/[\r?\n]+/g, '\n');
};

// --- Main New Function ---

export async function fetchEmailsAndAttachments(
  jwtClient: JWT,
  filters: EmailFilters = {}
): Promise<FetchedEmailData[]> {
  const gmail = google.gmail({ version: 'v1', auth: jwtClient });
  const outputDir = path.resolve(process.cwd(), 'downloads', 'email_attachments');
  await fs.mkdir(outputDir, { recursive: true });

  // 1. Build the search query
  const queryParts: string[] = ['-in:promotions'];
  if (filters.fromEmail) queryParts.push(`from:(${filters.fromEmail})`);
  if (filters.subject) queryParts.push(`subject:(${filters.subject})`);
  if (filters.startDate) queryParts.push(`after:${new Date(filters.startDate).toISOString().split('T')[0]}`);
  if (filters.endDate) queryParts.push(`before:${new Date(filters.endDate).toISOString().split('T')[0]}`);
  const query = queryParts.join(' ');

  console.log(`Using Gmail query: "${query}"`);

  // 2. List messages matching the query
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 25, // Limit results for safety
  });

  const messages = listResponse.data.messages;
  if (!messages || messages.length === 0) {
    console.log('No emails found matching the criteria.');
    return [];
  }

  console.log(`Found ${messages.length} email(s). Fetching details...`);

  const allFetchedData: FetchedEmailData[] = [];

  // 3. Process each message
  for (const message of messages) {
    if (!message.id) continue;

    const msgResponse = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full',
    });

    const payload = msgResponse.data.payload;
    if (!payload) continue;

    const headers = payload.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const emailBody = getBody(payload);
    const attachmentPaths: string[] = [];

    // 4. Find and download attachments
    const parts = payload.parts || [];
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        try {
          const attachment = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: message.id,
            id: part.body.attachmentId,
          });

          if (attachment.data.data) {
            const fileBuffer = Buffer.from(attachment.data.data, 'base64');
            const fileExtension = path.extname(part.filename) || '.dat';
            const uniqueFilename = `${uuidv4()}${fileExtension}`;
            const filePath = path.join(outputDir, uniqueFilename);

            await fs.writeFile(filePath, fileBuffer);
            attachmentPaths.push(filePath);
            console.log(`  - Downloaded attachment: ${part.filename} -> ${filePath}`);
          }
        } catch (error) {
          console.error(`  - Failed to download attachment ${part.filename}:`, error);
        }
      }
    }

    allFetchedData.push({
      emailBody,
      attachmentPaths,
      subject: getHeader('subject'),
      from: getHeader('from'),
      date: getHeader('date'),
    });
  }

  return allFetchedData;
}
