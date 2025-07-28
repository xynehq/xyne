import { config } from 'dotenv';
config();
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

// Types
interface VisitOptions {
  namespace?: string;
  schema?: string;
  continuation?: string;
  wantedDocumentCount?: number;
  fieldSet?: string;
  concurrency?: number;
  cluster?: string;
}

interface VisitResponse {
  documents: any[];
  continuation?: string;
  documentCount: number;
}

interface MailDocument {
  fields: {
    docId: string;
    subject: string;
    chunks: string[];
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    timestamp: number;
    attachmentFilenames?: string[];
    labels?: string[];
  };
  id: string;
}

interface TagResult {
  docId: string;
  tags: string[];
  newTags: string[];
  existingTags: string[];
}

interface GlobalTagsData {
  tags: string[];
  documentTags: Record<string, string[]>;
}

// Vespa Client with the provided visit function
class VespaClient {
  private vespaEndpoint: string;

  constructor(endpoint: string) {
    this.vespaEndpoint = endpoint;
  }

  async fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url, options);
        return response;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Max retries reached');
  }

  async visit(options: VisitOptions): Promise<VisitResponse> {
    const {
      namespace,
      schema = "mail",
      continuation,
      wantedDocumentCount = 50,
      fieldSet = `${schema}:*`,
      concurrency = 1,
      cluster = 'my_content'
    } = options;
    
    const NAMESPACE = "namespace"; // Replace with your actual namespace
    const params = new URLSearchParams({
      wantedDocumentCount: wantedDocumentCount.toString(),
      cluster: cluster,
      selection: schema,
      ...(continuation ? { continuation } : {})
    });
    
    const url = `${this.vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid?${params.toString()}`;
    
    try {
      // console.log(url)
      const response = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = response.statusText;
        throw new Error(
          `Visit failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }
      
      const data = await response.json();
      return {
        documents: data.documents || [],
        continuation: data.continuation,
        documentCount: data.documentCount || 0
      };
    } catch (error) {
      const errMessage = (error as Error).message;
      console.error(`Error visiting documents: ${errMessage}`);
      throw new Error(`Error visiting documents: ${errMessage}`);
    }
  }
}

// Vertex AI Tag Service
class VertexAITagService {
  private client: AnthropicVertex;
  private model: string;

  constructor() {
    const projectId = process.env.VERTEX_PROJECT_ID || 'dev-ai-gamma';
    const region = process.env.VERTEX_REGION || 'us-east5';
    this.model = process.env.VERTEX_AI_MODEL || 'claude-3-5-sonnet-v2@20241022';
    this.client = new AnthropicVertex({ projectId, region });
  }

  private createTagPrompt(document: MailDocument, globalTags: string[]): string {
    const fields = document.fields;
    const content = `
Subject: ${fields.subject || 'No subject'}
From: ${fields.from || 'Unknown sender'}
To: ${fields.to?.join(', ') || 'No recipients'}
${fields.cc ? `CC: ${fields.cc.join(', ')}` : ''}
Content: ${fields.chunks?.join(' ') || 'No content'}
${fields.attachmentFilenames ? `Attachments: ${fields.attachmentFilenames.join(', ')}` : ''}
    `.trim();

    return `You are an advanced document analysis assistant specializing in extracting hierarchical concepts, intents, and relationships from email communications.

Analyze the following email document and create a comprehensive hierarchical structure of information.

Current global tags available: ${globalTags.length > 0 ? globalTags.join(', ') : 'None'}

Document to analyze:
${content}

Your task is to extract and organize information into the following hierarchical structure:

1. **Primary Intent** - The main purpose or goal of the email
2. **Secondary Intents** - Supporting purposes or sub-goals
3. **Entities** - Key people, organizations, projects, systems mentioned
4. **Concepts** - Abstract ideas, topics, or themes
5. **Actions** - Required actions, decisions, or next steps
6. **Context** - Business context, urgency, timeline, dependencies
7. **Relationships** - How entities, concepts, and actions relate to each other

Return a JSON response with the following structure:

{
  "hierarchy": {
    "primaryIntent": {
      "intent": "string describing the main purpose",
      "confidence": 0.0-1.0,
      "keywords": ["key", "words"]
    },
    "secondaryIntents": [
      {
        "intent": "string describing secondary purpose",
        "confidence": 0.0-1.0,
        "relatedTo": "primaryIntent or other element"
      }
    ],
    "entities": {
      "people": [
        {
          "name": "person name",
          "role": "their role/title if mentioned",
          "context": "why they're relevant"
        }
      ],
      "organizations": [
        {
          "name": "company/dept name",
          "type": "company/department/team",
          "relevance": "why mentioned"
        }
      ],
      "projects": [
        {
          "name": "project name",
          "status": "if mentioned",
          "importance": "high/medium/low"
        }
      ],
      "systems": [
        {
          "name": "system/tool name",
          "purpose": "what it's used for",
          "action": "what needs to be done with it"
        }
      ]
    },
    "concepts": [
      {
        "concept": "concept name",
        "category": "technical/business/process/other",
        "importance": "high/medium/low",
        "relatedConcepts": ["other", "concepts"]
      }
    ],
    "actions": [
      {
        "action": "what needs to be done",
        "actor": "who should do it",
        "deadline": "when if mentioned",
        "priority": "high/medium/low",
        "dependencies": ["what it depends on"]
      }
    ],
    "context": {
      "businessContext": "overall business situation",
      "urgency": "urgent/high/normal/low",
      "timeline": "specific dates or timeframes mentioned",
      "constraints": ["any limitations or requirements"],
      "risks": ["potential risks mentioned"]
    },
    "relationships": [
      {
        "type": "depends_on/relates_to/impacts/requires",
        "from": "entity/concept/action",
        "to": "entity/concept/action",
        "strength": "strong/moderate/weak",
        "description": "nature of relationship"
      }
    ]
  },
  "suggestedTags": {
    "intentTags": ["tags based on intents"],
    "entityTags": ["tags for key entities"],
    "conceptTags": ["tags for main concepts"],
    "actionTags": ["tags for required actions"],
    "contextTags": ["tags for context/urgency"]
  },
  "summary": {
    "oneLiner": "one line summary of the email",
    "keyTakeaways": ["main points to remember"],
    "classification": {
      "type": "request/update/decision/information/discussion",
      "domain": "technical/business/administrative/other",
      "sentiment": "positive/neutral/negative/urgent"
    }
  }
}

Guidelines:
1. Extract explicit information when available, infer carefully when not
2. Identify both direct and implied relationships
3. Consider the email's position in a potential conversation thread
4. Look for patterns that suggest recurring themes or ongoing initiatives
5. Differentiate between immediate actions and long-term goals
6. Identify any compliance, security, or policy-related content
7. Note any metrics, KPIs, or success criteria mentioned
8. Capture any decision points or approvals needed
9. Identify stakeholders even if not directly addressed
10. Consider cultural or organizational context clues

Focus on creating a rich, interconnected understanding of the email that goes beyond simple keyword extraction.`;
  }

  async generateTags(document: MailDocument, globalTags: string[]): Promise<{
    tags: string[];
    companyTags: string[];
    generalTags: string[];
    hierarchy?: any;
    summary?: any;
  }> {
    const prompt = this.createTagPrompt(document, globalTags);
    
    try {
      console.log('🤖 Calling Vertex AI (Claude)...');
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      // Extract text content from the response
      let content = '';
      if (response.content && response.content.length > 0) {
        const firstContent = response.content[0];
        if ('text' in firstContent) {
          content = firstContent.text;
        } else {
          throw new Error('Unexpected response format from Vertex AI');
        }
      }
      
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }
      
      const result = JSON.parse(content);
      
      // Extract all tags from the hierarchical structure
      const allTags = new Set<string>();
      const companyTags = new Set<string>();
      const generalTags = new Set<string>();
      
      // Add suggested tags
      if (result.suggestedTags) {
        Object.values(result.suggestedTags).forEach((tagArray: any) => {
          if (Array.isArray(tagArray)) {
            tagArray.forEach(tag => allTags.add(tag.toLowerCase()));
          }
        });
        
        // Add entity tags as company tags
        if (result.suggestedTags.entityTags) {
          result.suggestedTags.entityTags.forEach((tag: string) => companyTags.add(tag.toLowerCase()));
        }
        
        // Add concept and intent tags as general tags
        if (result.suggestedTags.conceptTags) {
          result.suggestedTags.conceptTags.forEach((tag: string) => generalTags.add(tag.toLowerCase()));
        }
        if (result.suggestedTags.intentTags) {
          result.suggestedTags.intentTags.forEach((tag: string) => generalTags.add(tag.toLowerCase()));
        }
      }
      
      // Add classification type as a tag
      if (result.summary?.classification?.type) {
        allTags.add(result.summary.classification.type.toLowerCase());
      }
      
      // Add urgency as a tag if it's high or urgent
      if (result.hierarchy?.context?.urgency && 
          ['urgent', 'high'].includes(result.hierarchy.context.urgency.toLowerCase())) {
        allTags.add(result.hierarchy.context.urgency.toLowerCase());
      }
      
      return {
        tags: Array.from(allTags),
        companyTags: Array.from(companyTags),
        generalTags: Array.from(generalTags),
        hierarchy: result.hierarchy,
        summary: result.summary
      };
    } catch (error) {
      console.error('Error generating tags with Vertex AI:', error);
      // Fallback to basic tags if Ollama fails
      return {
        tags: ['untagged'],
        companyTags: [],
        generalTags: []
      };
    }
  }
}

// Global Tags Manager
class GlobalTagsManager {
  private globalTags: Set<string>;
  private documentTags: Map<string, string[]>;

  constructor() {
    this.globalTags = new Set<string>();
    this.documentTags = new Map<string, string[]>();
  }

  addTags(tags: string[]): string[] {
    const newTags: string[] = [];
    tags.forEach(tag => {
      if (!this.globalTags.has(tag)) {
        this.globalTags.add(tag);
        newTags.push(tag);
      }
    });
    return newTags;
  }

  assignTagsToDocument(docId: string, tags: string[]): void {
    this.documentTags.set(docId, tags);
  }

  getGlobalTags(): string[] {
    return Array.from(this.globalTags);
  }

  getDocumentTags(docId: string): string[] {
    return this.documentTags.get(docId) || [];
  }

  exportData(): GlobalTagsData {
    const documentTagsObj: Record<string, string[]> = {};
    this.documentTags.forEach((tags, docId) => {
      documentTagsObj[docId] = tags;
    });

    return {
      tags: this.getGlobalTags(),
      documentTags: documentTagsObj
    };
  }
}

// Main function to process Vespa documents
async function processVespaDocuments() {
  console.log('🚀 Starting Vespa Document Tagging Process\n');
  
  // Initialize services
  // Use localhost when running outside Docker, or VESPA_HOST when inside Docker
  const vespaHost = process.env.VESPA_HOST === 'vespa' && !process.env.RUNNING_IN_DOCKER ? 'localhost' : (process.env.VESPA_HOST || 'localhost');
  const vespaEndpoint = `http://${vespaHost}:8080`;
  const vespaClient = new VespaClient(vespaEndpoint);
  const vertexAIService = new VertexAITagService();
  const tagsManager = new GlobalTagsManager();

  console.log(`📡 Vespa endpoint: ${vespaEndpoint}`);
  console.log(`🤖 Vertex AI Project: ${process.env.VERTEX_PROJECT_ID}`);
  console.log(`🤖 Vertex AI Region: ${process.env.VERTEX_REGION}`);
  console.log(`🤖 Vertex AI Model: ${process.env.VERTEX_AI_MODEL}\n`);

  try {
    // Fetch all documents from Vespa using pagination
    console.log('📄 Fetching all documents from Vespa...');
    
    let allDocuments: any[] = [];
    let continuation: string | undefined = undefined;
    let pageCount = 0;
    const documentsPerPage = 100; // Fetch 100 documents per request
    
    // Keep fetching until no more continuation token
    do {
      const visitResponse = await vespaClient.visit({
        schema: 'mail',
        wantedDocumentCount: documentsPerPage,
        cluster: 'my_content',
        continuation: continuation
      });
      
      pageCount++;
      allDocuments = allDocuments.concat(visitResponse.documents);
      continuation = visitResponse.continuation;
      
      console.log(`📄 Page ${pageCount}: Fetched ${visitResponse.documents.length} documents (Total: ${allDocuments.length})`);
      
      // Small delay between requests to avoid overwhelming the server
      if (continuation) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } while (continuation);

    console.log(`\n✅ Fetched total of ${allDocuments.length} documents from Vespa\n`);

    if (allDocuments.length === 0) {
      console.log('No documents found in Vespa. Exiting...');
      return;
    }

    // Process only first 10 documents for testing
    const documentsToProcess = Math.min(10, allDocuments.length);
    console.log(`\n⚡ Processing only first ${documentsToProcess} documents for faster testing\n`);
    
    for (let i = 0; i < documentsToProcess; i++) {
      const doc = allDocuments[i];
      const mailDoc = doc as MailDocument;
      const docId = mailDoc.fields.docId || mailDoc.id;
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📧 Processing Document ${i + 1}/${documentsToProcess}: ${docId}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Subject: ${mailDoc.fields.subject || 'No subject'}`);
      console.log(`From: ${mailDoc.fields.from || 'Unknown'}`);
      console.log(`To: ${mailDoc.fields.to?.join(', ') || 'No recipients'}`);
      
      // Get current global tags
      const currentGlobalTags = tagsManager.getGlobalTags();
      console.log(`\n📌 Current global tags (${currentGlobalTags.length}): ${currentGlobalTags.length > 0 ? currentGlobalTags.join(', ') : 'None'}`);
      
      // Generate tags using Vertex AI
      console.log('\n🤖 Generating tags with Vertex AI (Claude)...');
      const tagResult = await vertexAIService.generateTags(mailDoc, currentGlobalTags);
      
      // Combine all tags
      const allTags = [...new Set([...tagResult.tags, ...tagResult.companyTags, ...tagResult.generalTags])];
      
      // Add new tags to global list
      const newTags = tagsManager.addTags(allTags);
      
      // Assign tags to document
      tagsManager.assignTagsToDocument(docId, allTags);
      
      // Display results
      console.log(`\n✅ Vertex AI suggested tags:`);
      console.log(`   - All tags: ${tagResult.tags.join(', ') || 'None'}`);
      console.log(`   - Company tags: ${tagResult.companyTags.join(', ') || 'None'}`);
      console.log(`   - General tags: ${tagResult.generalTags.join(', ') || 'None'}`);
      
      // Display hierarchical analysis if available
      if (tagResult.hierarchy) {
        console.log(`\n📊 Hierarchical Analysis:`);
        if (tagResult.hierarchy.primaryIntent) {
          console.log(`   - Primary Intent: ${tagResult.hierarchy.primaryIntent.intent} (confidence: ${tagResult.hierarchy.primaryIntent.confidence})`);
        }
        if (tagResult.summary?.oneLiner) {
          console.log(`   - Summary: ${tagResult.summary.oneLiner}`);
        }
        if (tagResult.summary?.classification) {
          console.log(`   - Type: ${tagResult.summary.classification.type}`);
          console.log(`   - Domain: ${tagResult.summary.classification.domain}`);
          console.log(`   - Sentiment: ${tagResult.summary.classification.sentiment}`);
        }
      }
      
      console.log(`\n📍 Final assigned tags: ${allTags.join(', ')}`);
      console.log(`🆕 New tags added to global list: ${newTags.length > 0 ? newTags.join(', ') : 'None'}`);
      
      // Small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Export and display final results
    const finalData = tagsManager.exportData();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 FINAL RESULTS');
    console.log(`${'='.repeat(60)}\n`);
    
    console.log('🌐 GLOBAL TAGS JSON:');
    console.log(JSON.stringify(finalData.tags, null, 2));
    
    console.log('\n📄 DOCUMENT TAGS JSON:');
    console.log(JSON.stringify(finalData.documentTags, null, 2));
    
    // Summary statistics
    console.log(`\n📈 SUMMARY:`);
    console.log(`   - Total documents processed: ${Object.keys(finalData.documentTags).length}`);
    console.log(`   - Total unique tags created: ${finalData.tags.length}`);
    console.log(`   - Documents with tags: ${Object.keys(finalData.documentTags).length}`);
    
    // Save to file
    const fs = await import('fs/promises');
    const outputPath = './vespa-tags-output.json';
    await fs.writeFile(outputPath, JSON.stringify(finalData, null, 2));
    console.log(`\n� Results saved to: ${outputPath}`);

  } catch (error) {
    console.error('\n❌ Error processing documents:', error);
  }
}

// Run the script
if (import.meta.main) {
  processVespaDocuments()
    .then(() => {
      console.log('\n✨ Process completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Fatal error:', error);
      process.exit(1);
    });
}

export { VespaClient, VertexAITagService, GlobalTagsManager };
