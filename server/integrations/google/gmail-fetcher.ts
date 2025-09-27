// -- This file fetches emails and their attachments from Gmail using the Gmail API. --
import { google, gmail_v1 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getBody } from './gmail-worker';
import { getLogger } from '@/logger';
import { Subsystem } from '@/types';
import pLimit from 'p-limit';
import { GmailConcurrency } from './config';

const Logger = getLogger(Subsystem.Integrations);

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

// --- Main New Function ---

export async function fetchEmailsAndAttachments(
  jwtClient: JWT,
  filters: EmailFilters = {}
): Promise<FetchedEmailData[]> {
  const gmail = google.gmail({ version: 'v1', auth: jwtClient });
  const outputDir = path.resolve(__dirname, '..', '..', '..', 'downloads', 'email_attachments');
  await fs.mkdir(outputDir, { recursive: true });

  // 1. Build the search query
  const queryParts: string[] = ['-in:promotions'];
  if (filters.fromEmail) queryParts.push(`from:(${filters.fromEmail})`);
  if (filters.subject) queryParts.push(`subject:(${filters.subject})`);
  if (filters.startDate) {
    const startDateObj = new Date(filters.startDate);
    const formattedStartDate = startDateObj.toISOString().split('T')[0].replace(/-/g, '/');
    queryParts.push(`after:${formattedStartDate}`);
  }
  if (filters.endDate) {
    const endDateObj = new Date(filters.endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    const formattedExclusiveEndDate = endDateObj.toISOString().split('T')[0].replace(/-/g, '/');
    queryParts.push(`before:${formattedExclusiveEndDate}`);
  }
  const query = queryParts.join(' ');

  Logger.info(`Using Gmail query: "${query}"`);

  // 2. List messages matching the query
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 25, // Limit results for safety
  });

  const messages = listResponse.data.messages;
  if (!messages || messages.length === 0) {
    Logger.info('No emails found matching the criteria.');
    return [];
  }

  Logger.info(`Found ${messages.length} email(s). Fetching details...`);

  const limit = pLimit(GmailConcurrency);
  const promises = messages.map(message => limit(async () => {
    if (!message.id) return null;

    const msgResponse = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full',
    });

    const payload = msgResponse.data.payload;
    if (!payload) return null;

    const headers = payload.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const emailBody = getBody(payload);
    const attachmentPaths: string[] = [];

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
            Logger.info(`  - Downloaded attachment: ${part.filename} -> ${filePath}`);
          }
        } catch (error) {
          Logger.error(`  - Failed to download attachment ${part.filename}:`, error);
        }
      }
    }

    return {
      emailBody,
      attachmentPaths,
      subject: getHeader('subject'),
      from: getHeader('from'),
      date: getHeader('date'),
    };
  }));

  const results = await Promise.all(promises);
  return results.filter((result): result is FetchedEmailData => result !== null);
}
