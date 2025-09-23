import { chromium, type Browser, type Page } from 'playwright';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RBI_CONFIG } from './config.js';

import { FileProcessorService } from '@/services/fileProcessor';
import { insert } from '@/search/vespa';
import { KbItemsSchema } from '@xyne/vespa-ts/types';
import { Apps, KnowledgeBaseEntity } from '@xyne/vespa-ts/types';
import { v4 as uuidv4 } from 'uuid';
import { getUserByEmail } from '@/db/user';
import { getLogger } from "@/logger"
import { Subsystem } from '@/logger';
import {
    createCollection,
    createFileItem,
    getCollectionsByOwner,
    generateFileVespaDocId,
    generateStorageKey,
    generateCollectionVespaDocId,
} from '@/db/knowledgeBase';
import { db } from '@/db/client';

// Knowledge Base storage path
const KB_STORAGE_ROOT = path.join(process.cwd(), "storage", "kb_files");
const Logger = getLogger(Subsystem.Integrations).child({
    module: "rbi-automation",
})
  class RBICircularDownloader {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async initialize(): Promise<void> {
        console.log('🚀 Initializing browser...');

        // Launch browser with configuration
        this.browser = await chromium.launch({
            headless: RBI_CONFIG.HEADLESS,
            channel: RBI_CONFIG.USE_SYSTEM_CHROME ? 'chrome' : undefined,
        });

        // Create new page/tab
        this.page = await this.browser.newPage();

        console.log('✅ Browser initialized successfully');
    }

    async navigateToHomePage(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        console.log(`🌐 Navigating to: ${RBI_CONFIG.BASE_URL}`);

        try {
            // Navigate to the RBI page
            await this.page.goto(RBI_CONFIG.BASE_URL, {
                waitUntil: 'domcontentloaded',
                timeout: RBI_CONFIG.TIMEOUT
            });

            // Wait for page to be fully interactive
            await this.page.waitForLoadState('networkidle');
            console.log('✅ Successfully loaded RBI circulars page');

        } catch (error) {
            throw new Error(`Failed to load RBI homepage: ${error}`);
        }
    }

    async clickYearLink(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        console.log(`📅 Looking for year ${RBI_CONFIG.TARGET_YEAR} link...`);

        // More precise selectors based on actual DOM structure
        const yearSelectors = [
            `#btn${RBI_CONFIG.TARGET_YEAR}`,                     // Most specific: ID selector
            `a[id="btn${RBI_CONFIG.TARGET_YEAR}"]`,              // ID with tag
            `text=${RBI_CONFIG.TARGET_YEAR}`,                    // Text content fallback
            `a:has-text("${RBI_CONFIG.TARGET_YEAR}")`,           // Link containing text
            `xpath=//a[@id='btn${RBI_CONFIG.TARGET_YEAR}']`      // XPath with ID
        ];

        let yearElement = null;

        // Try each selector until one works
        for (const selector of yearSelectors) {
            try {
                console.log(`  🔍 Trying selector: ${selector}`);
                yearElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (yearElement) {
                    console.log(`✅ Found year link with: ${selector}`);
                    break;
                }
            } catch (error) {
                console.log(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!yearElement) {
            throw new Error(`Year ${RBI_CONFIG.TARGET_YEAR} link not found with any selector`);
        }

        try {
            await yearElement.click();
            console.log(`✅ Clicked ${RBI_CONFIG.TARGET_YEAR} year link`);

            // Wait for year section to expand (important!)
            await this.page.waitForTimeout(2000);

        } catch (error) {
            throw new Error(`Failed to click year ${RBI_CONFIG.TARGET_YEAR}: ${error}`);
        }
    }

    async clickAllMonths(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        console.log(`📅 Looking for "All Months" link for year ${RBI_CONFIG.TARGET_YEAR}...`);

        // Strategy: Look for "All Months" link after year expansion
        const allMonthsSelectors = [
            `#${RBI_CONFIG.TARGET_YEAR}0`,                        // ID pattern: 20250 for 2025
            `a[id="${RBI_CONFIG.TARGET_YEAR}0"]`,                 // More specific ID selector
            `text=All Months`,                                    // Direct text match
            `a:has-text("All Months")`,                           // Link containing "All Months"
            `xpath=//a[contains(text(), "All Months")]`,          // XPath fallback
            `[onclick*="GetYearMonth"]`                           // onclick function pattern
        ];

        let allMonthsElement = null;

        // Try each selector until one works
        for (const selector of allMonthsSelectors) {
            try {
                console.log(`  🔍 Trying selector: ${selector}`);
                allMonthsElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (allMonthsElement) {
                    console.log(`✅ Found "All Months" link with: ${selector}`);
                    break;
                }
            } catch (error) {
                console.log(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!allMonthsElement) {
            throw new Error(`"All Months" link not found with any selector`);
        }

        try {
            await allMonthsElement.click();
            console.log(`✅ Clicked "All Months" link`);

            // Wait for the circular table to load (this might take longer)
            console.log('⏳ Waiting for all circulars to load...');
            await this.page.waitForLoadState('networkidle', { timeout: RBI_CONFIG.TIMEOUT });

        } catch (error) {
            throw new Error(`Failed to click "All Months": ${error}`);
        }
    }

    async findAndClickFirstCircular(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        console.log('🔍 Looking for circular table and first circular link...');

        // Wait for table to be fully loaded
        await this.page.waitForSelector('table.tablebg', { timeout: 10000 });
        console.log('✅ Found circular table');

        // Multiple strategies to find the first circular link
        const circularSelectors = [
            // Strategy 1: First link with class "link2" (most specific)
            'a.link2:first-of-type',

            // Strategy 2: First link in table that contains "Id=" (the circular detail links)
            'table a[href*="Id="]:first-of-type',

            // Strategy 3: First link in the second row, first column (skip header row)
            'table.tablebg tr:nth-child(3) td:first-child a',

            // Strategy 4: XPath for first circular link
            'xpath=//table[@class="tablebg"]//tr[3]//a[contains(@href, "Id=")]'
        ];

        let circularElement = null;
        for (const selector of circularSelectors) {
            try {
                console.log(`  🔍 Trying selector: ${selector}`);
                circularElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (circularElement) {
                    console.log(`✅ Found first circular link with: ${selector}`);
                    break;
                }
            } catch (error) {
                console.log(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!circularElement) {
            throw new Error('No circular links found in table');
        }

        try {
            // Get the href and circular text for logging
            const href = await circularElement.getAttribute('href');
            const circularText = await circularElement.textContent();
            console.log(`🔗 Found circular: ${circularText?.substring(0, 50)}...`);
            console.log(`🔗 Link URL: ${href}`);

            await circularElement.click();
            console.log('✅ Clicked first circular link');

            // Wait for the detail page to load
            await this.page.waitForLoadState('networkidle', { timeout: RBI_CONFIG.TIMEOUT });

        } catch (error) {
            throw new Error(`Failed to click circular link: ${error}`);
        }
    }

    async downloadPDF(): Promise<{ downloadPath: string }> {
        if (!this.page) throw new Error('Page not initialized');

        console.log('📄 Looking for PDF download link...');

        // Create downloads folder if it doesn't exist
        await fs.mkdir(RBI_CONFIG.DOWNLOADS_FOLDER, { recursive: true });

        const pdfSelectors = [
            'a[href*=".PDF"]',
            'a[href*=".pdf"]',
            'a img[src*="pdf.gif"]',
            'a:has(img[src*="pdf"])',
            'a[id^="APDF_"]',
        ];

        let pdfElement = null;
        for (const selector of pdfSelectors) {
            try {
                console.log(`  🔍 Trying selector: ${selector}`);
                pdfElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (pdfElement) {
                    console.log(`✅ Found PDF link with: ${selector}`);
                    break;
                }
            } catch (error) {
                console.log(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!pdfElement) {
            throw new Error('No PDF download link found');
        }

        try {
            // Get the PDF URL
            const pdfUrl = await pdfElement.getAttribute('href');
            if (!pdfUrl) {
                throw new Error('PDF link has no href');
            }

            console.log(`🔗 PDF URL: ${pdfUrl}`);

            // Convert relative URL to absolute URL if needed
            const absolutePdfUrl = pdfUrl.startsWith('http')
                ? pdfUrl
                : `https://rbidocs.rbi.org.in${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}`;

            console.log(`🔗 Absolute PDF URL: ${absolutePdfUrl}`);

            // Extract filename from URL
            const urlParts = absolutePdfUrl.split('/');
            const filename = urlParts[urlParts.length - 1];
            const downloadPath = path.join(RBI_CONFIG.DOWNLOADS_FOLDER, filename);

            console.log(`📁 Will save to: ${downloadPath}`);

            // Setup listener for new page (PDF will open in new tab)
            const newPagePromise = this.page.context().waitForEvent('page');

            // Click the PDF link (this will open new tab)
            await pdfElement.click();
            console.log('✅ Clicked PDF link, waiting for new page...');

            // Wait for new page to open
            const newPage = await newPagePromise;
            await newPage.waitForLoadState('networkidle');
            console.log('✅ New PDF page opened');

            // Now we can download directly from the PDF URL
            console.log('📥 Downloading PDF directly...');

            // Use the browser context to download the PDF
            const downloadedBuffer = await newPage.evaluate(async (url) => {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const arrayBuffer = await response.arrayBuffer();
                return Array.from(new Uint8Array(arrayBuffer));
            }, absolutePdfUrl);

            // Convert to Buffer and save
            const buffer = Buffer.from(downloadedBuffer);
            await fs.writeFile(downloadPath, buffer);

            // Close the new PDF page
            await newPage.close();
            console.log('✅ Closed PDF page');

            // Verify the download
            const stats = await fs.stat(downloadPath);
            if (stats.size === 0) {
                throw new Error('Downloaded file is empty');
            }

            console.log(`✅ PDF downloaded successfully: ${downloadPath}`);
            console.log(`📊 File size: ${(stats.size / 1024).toFixed(2)} KB`);
            return { downloadPath };

        } catch (error) {
            throw new Error(`Failed to download PDF: ${error}`);
        }
    }

    async createOrGetRBICollection(userEmail: string, workspaceId: number): Promise<string> {
        console.log('📁 Setting up RBI Circulars collection...');

        try {
            // Get user
            const users = await getUserByEmail(db, userEmail);
            if (!users || users.length === 0) {
                throw new Error(`User not found: ${userEmail}`);
            }
            const user = users[0];

            // Check if RBI collection exists
            const collections = await getCollectionsByOwner(db, user.id);
            const rbiCollection = collections.find(c => c.name === 'RBI Circulars');

            if (rbiCollection) {
                console.log(`✅ Found existing RBI collection: ${rbiCollection.id}`);
                return rbiCollection.id;
            }

            // Create new RBI collection
            const newCollection = await db.transaction(async (tx) => {
                const vespaDocId = generateCollectionVespaDocId()
                const collection = await createCollection(tx, {
                    name: 'RBI Circulars',
                    description: 'Automated collection of RBI circular documents',
                    workspaceId,
                    ownerId: user.id,
                    isPrivate: false,
                    lastUpdatedById: user.id,
                    lastUpdatedByEmail: userEmail,
                    metadata: { source: 'rbi-automation', vespaDocId: vespaDocId }
                });

                // Add to Vespa for search
                const vespaDoc = {
                    docId: vespaDocId,
                    clId: collection.id,
                    itemId: collection.id,
                    fileName: 'RBI Circulars',
                    app: Apps.KnowledgeBase as const,
                    entity: KnowledgeBaseEntity.Collection,
                    description: 'Automated RBI circular collection',
                    storagePath: "",
                    chunks: [],
                    chunks_pos: [],
                    image_chunks: [],
                    image_chunks_pos: [],
                    metadata: JSON.stringify({ source: 'rbi-automation', vespaDocId: vespaDocId }),
                    createdBy: userEmail,
                    duration: 0,
                    mimeType: 'application/pdf',
                    fileSize: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

                await insert(vespaDoc, KbItemsSchema);
                return collection;
            });

            console.log(`✅ Created RBI collection: ${newCollection.id}`);
            return newCollection.id;

        } catch (error) {
            throw new Error(`Failed to create RBI collection: ${error}`);
        }
    }

    async processAndIngestPDF(downloadPath: string, userEmail: string, workspaceId: number): Promise<void> {
        console.log('🔄 Processing PDF for complete Knowledge Base ingestion...');

        try {
            // STEP 1: Get user and RBI collection
            const users = await getUserByEmail(db, userEmail);
            // logger.info('Users fetched', { users });
            console.log(`👤 Fetched user for ingestion: ${userEmail} and ${users.length} found`);
            if (!users || users.length === 0) {
                throw new Error(`User not found: ${userEmail}`);
            }
            const user = users[0];
            console.log(`👤 User ID: ${user.id}, Email: ${user.email}`);

            // Get or create RBI collection
            const collectionId = await this.createOrGetRBICollection(userEmail, workspaceId);

            // STEP 2: Read and process the PDF
            const pdfBuffer = await fs.readFile(downloadPath);
            const stats = await fs.stat(downloadPath);
            const fileName = path.basename(downloadPath);

            // Generate unique IDs
            const vespaDocId = generateFileVespaDocId();
            const storageKey = generateStorageKey();

            console.log(`📝 Processing: ${fileName} (${(stats.size / 1024).toFixed(2)} KB)`);

            // STEP 3: Process PDF into chunks
            console.log('⚙️ Extracting text and chunks from PDF...');
            const processingResult = await FileProcessorService.processFile(
                pdfBuffer,
                'application/pdf',
                fileName,
                vespaDocId,
                undefined,  // No storage path needed for processing
                true,       // Extract images
                false       // Don't describe images
            );

            console.log(`✅ Extracted ${processingResult.chunks.length} text chunks and ${processingResult.image_chunks.length} image chunks`);

            // STEP 4: Create proper storage path (following your app's pattern)
            const year = new Date().getFullYear();
            const month = String(new Date().getMonth() + 1).padStart(2, '0');
            const storagePath = path.join(
                KB_STORAGE_ROOT,
                user.workspaceExternalId,
                collectionId,
                year.toString(),
                month,
                `${storageKey}_${fileName}`
            );

            // Ensure directory exists and copy file
            await fs.mkdir(path.dirname(storagePath), { recursive: true });
            await fs.copyFile(downloadPath, storagePath);

            console.log(`📁 File copied from downloads to KB storage: ${storagePath}`);

            // STEP 5: Database transaction - Create both collection item AND Vespa document
            await db.transaction(async (tx) => {
                // Create collection item (PostgreSQL record) - CORRECT FUNCTION SIGNATURE
                const collectionItem = await createFileItem(
                    tx,                    // transaction
                    collectionId,          // collectionId
                    null,                  // parentId (root level)
                    fileName,              // name
                    vespaDocId,           // vespaDocId
                    fileName,              // originalName
                    storagePath,          // storagePath
                    storageKey,           // storageKey
                    'application/pdf',    // mimeType
                    stats.size,           // fileSize
                    crypto.createHash('sha256').update(pdfBuffer).digest('hex'), // checksum
                    {                     // metadata
                        source: 'rbi-automation',
                        originalUrl: this.page?.url() || '',
                        downloadedAt: Date.now(),
                    },
                    user.id,              // userId
                    userEmail             // userEmail
                );

                console.log(`✅ Created collection item: ${collectionItem.id}`);

                // Create Vespa document (searchable content)
                const vespaDoc = {
                    docId: vespaDocId,
                    clId: collectionId,
                    itemId: collectionItem.id,  // Use the actual collection item ID
                    fileName: fileName,
                    app: Apps.KnowledgeBase as const,
                    entity: KnowledgeBaseEntity.File,
                    description: 'RBI Circular Document',
                    storagePath: storagePath,
                    chunks: processingResult.chunks,
                    chunks_pos: processingResult.chunks_pos,
                    image_chunks: processingResult.image_chunks || [],
                    image_chunks_pos: processingResult.image_chunks_pos || [],
                    metadata: JSON.stringify({
                        source: 'rbi-automation',
                        circularNumber: 'Auto-downloaded',
                        department: 'Reserve Bank of India',
                        subject: 'RBI Circular Document',
                        dateOfIssue: new Date().toISOString().split('T')[0],
                        originalUrl: this.page?.url() || '',
                        downloadedAt: Date.now(),
                        chunksCount: processingResult.chunks.length,
                        imageChunksCount: processingResult.image_chunks.length,
                        processingMethod: 'FileProcessorService',
                    }),
                    createdBy: userEmail,
                    duration: 0,
                    mimeType: 'application/pdf',
                    fileSize: stats.size,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

                await insert(vespaDoc, KbItemsSchema);
                console.log(`✅ Created Vespa document: ${vespaDocId}`);
            });

            console.log(`🎉 SUCCESS: RBI PDF fully integrated into Knowledge Base!`);
            console.log(`📊 Collection: RBI Circulars`);
            console.log(`📄 File: ${fileName}`);
            console.log(`💾 Stored: ${storagePath}`);
            console.log(`🔍 Now searchable and visible in UI`);

        } catch (error) {
            throw new Error(`Failed to process and ingest PDF: ${error}`);
        }
    }

    async cleanup(): Promise<void> {
        console.log('🧹 Cleaning up...');
        if (this.browser) {
            await this.browser.close();
            console.log('✅ Browser closed');
        }
    }

    async testCompleteFlow(): Promise<string> {
        try {
            // Hardcode user details (or make them parameters)
            const userEmail = 'aman.asrani@juspay.in';
            const workspaceId = 1;

            await this.initialize();
            await this.navigateToHomePage();
            await this.clickYearLink();
            await this.clickAllMonths();
            await this.findAndClickFirstCircular();
            const { downloadPath } = await this.downloadPDF();

            // Pass user details to processing method
            await this.processAndIngestPDF(downloadPath, userEmail, workspaceId);

            console.log('🎉 Complete automation successful!');
            return downloadPath;

        } catch (error) {
            console.error('❌ Automation failed:', error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }
}

export async function testCompleteFlow(): Promise<void> {
    const downloader = new RBICircularDownloader();
    try {
        const downloadPath = await downloader.testCompleteFlow();
        console.log(`\n🎯 SUCCESS: RBI circular is now searchable in your AI knowledge base!`);
        console.log(`📁 Local copy: ${downloadPath}`);
    } catch (error) {
        console.error('\n💥 FAILED:', error);
        process.exit(1);
    }
}

// Run test if this file is executed directly
if (require.main === module) {
    testCompleteFlow().catch(console.error);
}