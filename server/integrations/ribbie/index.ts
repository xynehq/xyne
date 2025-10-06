import { chromium, type Browser, type Page } from 'playwright';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RIBBIE_CONFIG } from './config.js';
import { FileProcessorService } from '@/services/fileProcessor';
import { insert } from '@/search/vespa';
import { KbItemsSchema } from '@xyne/vespa-ts/types';
import { Apps, KnowledgeBaseEntity } from '@xyne/vespa-ts/types';
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
const Logger = getLogger(Subsystem.Integrations)
class RIBBIECircularDownloader {
    private downloadedCircularIds = new Set<string>();

    // Add method to check duplicates
    private isAlreadyDownloaded(circularId: string): boolean {
        return this.downloadedCircularIds.has(circularId);
    }

    private markAsDownloaded(circularId: string): void {
        this.downloadedCircularIds.add(circularId);
    }
    private browser: Browser | null = null;
    private page: Page | null = null;

    async initialize(): Promise<void> {
        Logger.info('🚀 Initializing browser...');

        // Launch browser with configuration
        this.browser = await chromium.launch({
            headless: RIBBIE_CONFIG.HEADLESS,
            channel: RIBBIE_CONFIG.USE_SYSTEM_CHROME ? 'chrome' : undefined,
        });

        // Create new page/tab
        this.page = await this.browser.newPage();

        Logger.info('✅ Browser initialized successfully');
    }

    async navigateToHomePage(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        Logger.info(`🌐 Navigating to: ${process.env.RIBBIE_CONFIG_URL}`);

        try {
            // Navigate to the RIBBIE page
            await this.page.goto(`${process.env.RIBBIE_CONFIG_URL}`, {
                waitUntil: 'domcontentloaded',
                timeout: RIBBIE_CONFIG.TIMEOUT
            });

            // Wait for page to be fully interactive
            await this.page.waitForLoadState('networkidle');
            Logger.info('✅ Successfully loaded RIBBIE circulars page');

        } catch (error) {
            throw new Error(`Failed to load RIBBIE homepage`, { cause: error });
        }
    }

    async clickYearLink(year: number): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');
        const targetYear = year.toString();  // Convert year to string
        Logger.info(`📅 Looking for year ${targetYear} link...`);

        // More precise selectors based on actual DOM structure
        const yearSelectors = [
            `#btn${targetYear}`,                     // Most specific: ID selector
            `a[id="btn${targetYear}"]`,              // ID with tag
            `text=${targetYear}`,                    // Text content fallback
            `a:has-text("${targetYear}")`,           // Link containing text
            `xpath=//a[@id='btn${targetYear}']`      // XPath with ID
        ];

        let yearElement = null;

        // Try each selector until one works
        for (const selector of yearSelectors) {
            try {
                Logger.info(`  🔍 Trying selector: ${selector}`);
                yearElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (yearElement) {
                    Logger.info(`✅ Found year link with: ${selector}`);
                    break;
                }
            } catch (error) {
                Logger.info(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!yearElement) {
            throw new Error(`Year ${targetYear} link not found with any selector`);
        }

        try {
            await yearElement.click();
            Logger.info(`✅ Clicked ${targetYear} year link`);

            // Wait for the year section to expand by waiting for a month link to be visible.
            await this.page.waitForSelector(`a[id^="${targetYear}"]`, { timeout: 5000 });

        } catch (error) {
            throw new Error(`Failed to click year ${targetYear}: ${error}`);
        }
    }

    async clickAllMonths(year: number): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        Logger.info(`📅 Looking for "All Months" link for year ${year}...`);

        // Strategy: Look for "All Months" link 
        const allMonthsSelectors = [
            `#${year}0`,                        // ID pattern: 20250 for 2025
            `a[id="${year}0"]`,                 // More specific ID selector
            `text=All Months`,                                    // Direct text match
            `a:has-text("All Months")`,                           // Link containing "All Months"
            `xpath=//a[contains(text(), "All Months")]`,          // XPath fallback
            `[onclick*="GetYearMonth"]`                           // onclick function pattern
        ];

        let allMonthsElement = null;

        // Try each selector until one works
        for (const selector of allMonthsSelectors) {
            try {
                Logger.info(`  🔍 Trying selector: ${selector}`);
                allMonthsElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (allMonthsElement) {
                    Logger.info(`✅ Found "All Months" link with: ${selector}`);
                    break;
                }
            } catch (error) {
                Logger.info(`  ❌ Selector failed: ${selector}`);
                continue;
            }
        }

        if (!allMonthsElement) {
            throw new Error(`"All Months" link not found with any selector`);
        }

        try {
            await allMonthsElement.click();
            Logger.info(`✅ Clicked "All Months" link`);

            // Wait for the circular table to load (this might take longer)
            Logger.info('⏳ Waiting for all circulars to load...');
            await this.page.waitForLoadState('networkidle', { timeout: RIBBIE_CONFIG.TIMEOUT });

        } catch (error) {
            throw new Error(`Failed to click "All Months": ${error}`);
        }
    }
    async getAllCircularsFromTable(): Promise<Array<{ href: string, text: string, id: string, department: string }>> {
        if (!this.page) throw new Error('Page not initialized');

        Logger.info('🔍 Getting ALL circular links from the "All Months" table...');

        // Wait for table to be fully loaded
        await this.page.waitForSelector('table.tablebg', { timeout: 10000 });
        Logger.info('✅ Found circular table');

        // Get ALL circular data including department information
        const allCircularData = await this.page.$$eval(
            'table.tablebg tr',
            (rows) => {
                const results = [];

                // Skip header rows (first 2 rows)
                for (let i = 2; i < rows.length; i++) {
                    const row = rows[i];
                    const cells = row.querySelectorAll('td');

                    // Make sure we have all 5 columns: [Circular Number, Date, Department, Subject, Meant For]
                    if (cells.length >= 5) {
                        const linkElement = cells[0].querySelector('a[href*="Id="]');

                        if (linkElement) {
                            results.push({
                                href: linkElement.getAttribute('href') || '',
                                text: linkElement.textContent?.trim().substring(0, 80) + '...' || `Circular ${i - 1}`,
                                id: linkElement.getAttribute('href')?.match(/Id=(\d+)/)?.[1] || `${i - 1}`,
                                department: cells[2].textContent?.trim() || '', // Column 2 = Department
                                date: cells[1].textContent?.trim() || '',      // Column 1 = Date  
                                subject: cells[3].textContent?.trim() || ''    // Column 3 = Subject
                            });
                        }
                    }
                }

                return results;
            }
        );

        Logger.info(`✅ Found ${allCircularData.length} total circulars in table`);

        // Apply department filter
        const targetDepartment = RIBBIE_CONFIG.TARGET_DEPARTMENT;
        const filteredCirculars = allCircularData.filter(circular => {
            // Check for exact match or partial match with variations
            const dept = circular.department.toLowerCase();
            const target = targetDepartment.toLowerCase();

            // Handle variations in department names
            return dept.includes('payment and settlement system') ||
                dept.includes('payment and settlement systems') ||
                dept === target.toLowerCase();
        });

        Logger.info(`🎯 Filtered to ${filteredCirculars.length} circulars from "${targetDepartment}"`);

        // Log first few filtered results for verification
        filteredCirculars.slice(0, 3).forEach((circular, index) => {
            Logger.info(`  ${index + 1}. [${circular.department}] ${circular.text}`);
        });

        if (filteredCirculars.length > 3) {
            Logger.info(`  ... and ${filteredCirculars.length - 3} more from ${targetDepartment}`);
        }

        if (filteredCirculars.length === 0) {
            Logger.info(`⚠️ No circulars found for department: ${targetDepartment}`);
            Logger.info('📋 Available departments in this year:');

            // Show unique departments for debugging
            const uniqueDepartments = [...new Set(allCircularData.map(c => c.department))];
            uniqueDepartments.slice(0, 10).forEach(dept => {
                Logger.info(`   - ${dept}`);
            });
        }

        return filteredCirculars;
    }

    async navigateToCircular(circular: { href: string, text: string, id: string }): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        Logger.info(`🔗 Navigating to circular: ${circular.text}`);

        try {
            // Convert relative URL to absolute URL if needed
            const fullUrl = circular.href.startsWith('http')
                ? circular.href
                : `${process.env.RIBBIE_CONFIG_BASE_URL}/Scripts/${circular.href}`;

            Logger.info(`🔗 Full URL: ${fullUrl}`);

            // Navigate to the circular detail page
            await this.page.goto(fullUrl, {
                waitUntil: 'networkidle',
                timeout: RIBBIE_CONFIG.TIMEOUT
            });

            Logger.info('✅ Loaded circular detail page');

        } catch (error) {
            throw new Error(`Failed to navigate to circular: ${error}`);
        }
    }



    async downloadPDF(): Promise<{ downloadPath: string }> {
        if (!this.page) throw new Error('Page not initialized');

        Logger.info('📄 Looking for PDF download link...');

        // Create downloads folder if it doesn't exist
        await fs.mkdir(RIBBIE_CONFIG.DOWNLOADS_FOLDER, { recursive: true });

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
                Logger.info(`  🔍 Trying selector: ${selector}`);
                pdfElement = await this.page.waitForSelector(selector, { timeout: 5000 });

                if (pdfElement) {
                    Logger.info(`✅ Found PDF link with: ${selector}`);
                    break;
                }
            } catch (error) {
                Logger.info(`  ❌ Selector failed: ${selector}`);
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

            Logger.info(`🔗 PDF URL: ${pdfUrl}`);

            // Convert relative URL to absolute URL if needed
            const absolutePdfUrl = pdfUrl.startsWith('http')
                ? pdfUrl
                : `${process.env.RIBBIE_ABSOLUTE_PDF_URL}${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}`;

            Logger.info(`🔗 Absolute PDF URL: ${absolutePdfUrl}`);

            // Extract filename from URL
            const urlParts = absolutePdfUrl.split('/');
            const filename = urlParts[urlParts.length - 1];
            const downloadPath = path.join(RIBBIE_CONFIG.DOWNLOADS_FOLDER, filename);

            Logger.info(`📁 Will save to: ${downloadPath}`);

            // Setup listener for new page (PDF will open in new tab)
            const newPagePromise = this.page.context().waitForEvent('page');

            // Click the PDF link (this will open new tab)
            await pdfElement.click();
            Logger.info('✅ Clicked PDF link, waiting for new page...');

            // Wait for new page to open
            const newPage = await newPagePromise;
            await newPage.waitForLoadState('networkidle');
            Logger.info('✅ New PDF page opened');

            // Now we can download directly from the PDF URL
            Logger.info('📥 Downloading PDF directly...');

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
            Logger.info('✅ Closed PDF page');

            // Verify the download
            const stats = await fs.stat(downloadPath);
            if (stats.size === 0) {
                throw new Error('Downloaded file is empty');
            }

            Logger.info(`✅ PDF downloaded successfully: ${downloadPath}`);
            Logger.info(`📊 File size: ${(stats.size / 1024).toFixed(2)} KB`);
            return { downloadPath };

        } catch (error) {
            throw new Error(`Failed to download PDF: ${error}`);
        }
    }

    async createOrGetRBICollection(userEmail: string, workspaceId: number): Promise<string> {
        Logger.info('📁 Setting up RIBBIE Circulars collection...');

        try {
            // Get user
            const users = await getUserByEmail(db, userEmail);
            if (!users || users.length === 0) {
                throw new Error(`User not found: ${userEmail}`);
            }
            const user = users[0];

            // Check if RIBBIE collection exists
            const collections = await getCollectionsByOwner(db, user.id);
            const rbiCollection = collections.find(c => c.name === 'RIBBIE Payment Systems Circulars');

            if (rbiCollection) {
                Logger.info(`✅ Found existing RIBBIE collection: ${rbiCollection.id}`);
                return rbiCollection.id;
            }

            // Create new RIBBIE collection
            const newCollection = await db.transaction(async (tx) => {
                const vespaDocId = generateCollectionVespaDocId()
                const collection = await createCollection(tx, {
                    name: 'RIBBIE Payment Systems Circulars',
                    description: 'Automated collection of RIBBIE circular documents',
                    workspaceId,
                    ownerId: user.id,
                    isPrivate: true,
                    lastUpdatedById: user.id,
                    lastUpdatedByEmail: userEmail,
                    metadata: { source: 'RIBBIE-automation', vespaDocId: vespaDocId }
                });

                // Add to Vespa for search
                const vespaDoc = {
                    docId: vespaDocId,
                    clId: collection.id,
                    itemId: collection.id,
                    fileName: 'RIBBIE Circulars',
                    app: Apps.KnowledgeBase as const,
                    entity: KnowledgeBaseEntity.Collection,
                    description: 'Automated RIBBIE circular collection',
                    storagePath: "",
                    chunks: [],
                    chunks_pos: [],
                    image_chunks: [],
                    image_chunks_pos: [],
                    chunks_map: [],
                    image_chunks_map: [],
                    metadata: JSON.stringify({ source: 'RIBBIE-automation', vespaDocId: vespaDocId }),
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

            Logger.info(`✅ Created RIBBIE collection: ${newCollection.id}`);
            return newCollection.id;

        } catch (error) {
            throw new Error(`Failed to create RIBBIE collection: ${error}`);
        }
    }

    async processAndIngestPDF(downloadPath: string, userEmail: string, workspaceId: number, circular: { href: string, text: string, id: string, department: string }): Promise<void> {
        Logger.info('🔄 Processing PDF for complete Knowledge Base ingestion...');

        try {
            // STEP 1: Get user and RIBBIE collection
            const users = await getUserByEmail(db, userEmail);
            // logger.info('Users fetched', { users });
            Logger.info(`👤 Fetched user for ingestion: ${userEmail} and ${users.length} found`);
            if (!users || users.length === 0) {
                throw new Error(`User not found: ${userEmail}`);
            }
            const user = users[0];
            Logger.info(`👤 User ID: ${user.id}, Email: ${user.email}`);

            // Get or create RIBBIE collection
            const collectionId = await this.createOrGetRBICollection(userEmail, workspaceId);

            // STEP 2: Read and process the PDF
            const pdfBuffer = await fs.readFile(downloadPath);
            const stats = await fs.stat(downloadPath);
            const fileName = path.basename(downloadPath);

            // Generate unique IDs
            const vespaDocId = generateFileVespaDocId();
            const storageKey = generateStorageKey();

            Logger.info(`📝 Processing: ${fileName} (${(stats.size / 1024).toFixed(2)} KB)`);

            // STEP 3: Process PDF into chunks
            Logger.info('⚙️ Extracting text and chunks from PDF...');
            const processingResults = await FileProcessorService.processFile(
                pdfBuffer,
                'application/pdf',
                fileName,
                vespaDocId,
                undefined,  // No storage path needed for processing
                true,       // Extract images
                false       // Don't describe images
            );

            // For PDFs, we expect only one result, but handle array for consistency
            const processingResult = processingResults[0];
            if (!processingResult) {
                throw new Error('No processing result returned for PDF');
            }

            Logger.info(`✅ Extracted ${processingResult.chunks.length} text chunks and ${processingResult.image_chunks.length} image chunks`);

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

            Logger.info(`📁 File copied from downloads to KB storage: ${storagePath}`);

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
                        source: 'RIBBIE-automation',
                        originalUrl: this.page?.url() || '',
                        downloadedAt: Date.now(),
                    },
                    user.id,              // userId
                    userEmail             // userEmail
                );

                Logger.info(`✅ Created collection item: ${collectionItem.id}`);

                // Create Vespa document (searchable content)
                const vespaDoc = {
                    docId: vespaDocId,
                    clId: collectionId,
                    itemId: collectionItem.id,  // Use the actual collection item ID
                    fileName: fileName,
                    app: Apps.KnowledgeBase as const,
                    entity: KnowledgeBaseEntity.File,
                    description: 'RIBBIE Circular Document',
                    storagePath: storagePath,
                    chunks: processingResult.chunks,
                    chunks_pos: processingResult.chunks_pos,
                    image_chunks: processingResult.image_chunks || [],
                    image_chunks_pos: processingResult.image_chunks_pos || [],
                    chunks_map: processingResult.chunks_map || [],
                    image_chunks_map: processingResult.image_chunks_map || [],
                    metadata: JSON.stringify({
                        source: 'RIBBIE-automation',
                        circularNumber: circular.id,
                        department: circular.department,
                        subject: circular.text,
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
                Logger.info(`✅ Created Vespa document: ${vespaDocId}`);
            });

            Logger.info(`🎉 SUCCESS: RIBBIE PDF fully integrated into Knowledge Base!`);
            Logger.info(`📊 Collection: RIBBIE Circulars`);
            Logger.info(`📄 File: ${fileName}`);
            Logger.info(`💾 Stored: ${storagePath}`);
            Logger.info(`🔍 Now searchable and visible in UI`);

        } catch (error) {
            throw new Error(`Failed to process and ingest PDF: ${error}`);
        }
    }

    async cleanup(): Promise<void> {
        Logger.info('🧹 Cleaning up...');
        if (this.browser) {
            await this.browser.close();
            Logger.info('✅ Browser closed');
        }
    }

    async testCompleteFlow(): Promise<string[]> {
        try {
            // Hardcode user details (or make them parameters)
            const userEmail = `${process.env.RIBBIE_CONFIG_USER_EMAIL}`;
            const workspaceId = parseInt(process.env.RIBBIE_CONFIG_WORKSPACE_ID ||'1');
            const allDownloadedFiles: string[] = [];
            let totalSuccessfulYears = 0;
            let totalFailedYears = 0;
            let totalCirculars = 0;
            let totalSuccessfulCirculars = 0;

            await this.initialize();

            // Add this type guard right after initialize()
            if (!this.page) throw new Error('Page not initialized after browser setup');

            const years = RIBBIE_CONFIG.TARGET_YEARS;
            Logger.info(`🎯 Starting to process ${years.length} years: ${years.join(', ')}`);

            // Loop through each year
            for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
                const year = years[yearIndex];

                try {
                    Logger.info(`\n📅 Processing year ${year} (${yearIndex + 1}/${years.length})...`);

                    // Navigate to homepage for each year (fresh start)
                    await this.navigateToHomePage();

                    // Click the specific year
                    await this.clickYearLink(year);

                    // Click "All Months" for this year
                    await this.clickAllMonths(year);

                    // Get ALL circulars from the "All Months" table for this year
                    const allCirculars = await this.getAllCircularsFromTable();
                    Logger.info(`🎯 Found ${allCirculars.length} circulars for year ${year}`);
                    totalCirculars += allCirculars.length;

                    let yearSuccessCount = 0;
                    let yearErrorCount = 0;

                    // Process each circular for this year
                    for (let i = 0; i < allCirculars.length; i++) {
                        const circular = allCirculars[i];
                        Logger.info(`\n📄 [${year}] Processing ${i + 1}/${allCirculars.length}: ${circular.text}`);
                        Logger.info(`🏢 Department: ${circular.department}`);
                        Logger.info(`\n📄 [${year}] Processing ${i + 1}/${allCirculars.length}: ${circular.text}`);
                        Logger.info(`🏢 Department: ${circular.department}`);

                        try {
                            // Skip if already downloaded (optional optimization)
                            if (this.isAlreadyDownloaded(circular.id)) {
                                Logger.info(`⏭️ Skipping already processed circular ID: ${circular.id}`);
                                continue;
                            }

                            // Navigate to circular detail page
                            await this.navigateToCircular(circular);

                            // Download PDF from detail page
                            const { downloadPath } = await this.downloadPDF();

                            // Process and ingest into Knowledge Base
                            await this.processAndIngestPDF(downloadPath, userEmail, workspaceId, circular);

                            // Mark as successful
                            allDownloadedFiles.push(downloadPath);
                            this.markAsDownloaded(circular.id);
                            yearSuccessCount++;
                            totalSuccessfulCirculars++;

                            Logger.info(`✅ [${year}] Successfully processed ${i + 1}/${allCirculars.length}: ${downloadPath}`);

                        } catch (circularError) {
                            yearErrorCount++;
                            console.error(`❌ [${year}] Failed to process circular ${i + 1}/${allCirculars.length} (${circular.text}):`, circularError);

                            // Continue with next circular instead of failing completely
                            Logger.info(`⏭️ Continuing with next circular...`);
                        }

                        // Small delay between circulars to be respectful to the server
                        await this.page.waitForTimeout(1000);
                    }

                    // Year summary
                    totalSuccessfulYears++;
                    Logger.info(`\n✅ Year ${year} COMPLETE!`);
                    Logger.info(`📊 Year ${year}: ${yearSuccessCount} success, ${yearErrorCount} errors, ${allCirculars.length} total`);

                } catch (yearError) {
                    totalFailedYears++;
                    console.error(`❌ Failed to process year ${year}:`, yearError);
                    Logger.info(`⏭️ Continuing with next year...`);
                }

                // Delay between years
                if (yearIndex < years.length - 1) {
                    Logger.info(`⏳ Waiting 5 seconds before next year...`);
                    await this.page.waitForTimeout(5000);
                }
            }

            // Final summary
            Logger.info(`\n🎉 ALL YEARS COMPLETE!`);
            Logger.info(`📊 Final Results:`);
            Logger.info(`   Years processed: ${totalSuccessfulYears}/${years.length} successful`);
            Logger.info(`   Years failed: ${totalFailedYears}/${years.length}`);
            Logger.info(`   Total circulars found: ${totalCirculars}`);
            Logger.info(`   Total circulars downloaded: ${totalSuccessfulCirculars}`);
            Logger.info(`   Success rate: ${((totalSuccessfulCirculars / totalCirculars) * 100).toFixed(1)}%`);
            Logger.info(`📁 All PDFs are now searchable in your "RIBBIE Circulars" Knowledge Base collection!`);

            return allDownloadedFiles;

        } catch (error) {
            console.error('❌ Automation failed:', error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

}

export async function testCompleteFlow(): Promise<void> {
    const downloader = new RIBBIECircularDownloader();
    try {
        const downloadPath = await downloader.testCompleteFlow();
        Logger.info(`\n🎯 SUCCESS: RIBBIE circular is now searchable in your AI knowledge base!`);
        Logger.info(`📁 Local copy: ${downloadPath.join(', ')}`);
    } catch (error) {
        console.error('\n💥 FAILED:', error);
        process.exit(1);
    }
}

// Run test if this file is executed directly
if (import.meta.main) {
    if (!process.env.RIBBIE_ABSOLUTE_PDF_URL || !process.env.RIBBIE_CONFIG_URL || !process.env.RIBBIE_CONFIG_BASE_URL) {
        throw new Error('Environment variables RIBBIE_ABSOLUTE_PDF_URL, RIBBIE_CONFIG_URL, and RIBBIE_CONFIG_BASE_URL must be set');
    }

    testCompleteFlow().catch(console.error);
}
