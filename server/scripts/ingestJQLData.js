// Script to ingest JQL data into Vespa
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ingestJQLData() {
  console.log('🚀 Starting JQL data ingestion...');
  
  // Read the critical examples file
  const dataPath = path.join(__dirname, '../data/criticalExamplesToIngest.json');
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const jqlEntries = JSON.parse(rawData);
  
  console.log(`📄 Found ${jqlEntries.length} JQL entries to ingest`);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < jqlEntries.length; i++) {
    const entry = jqlEntries[i];
    
    try {
      // Convert to Vespa format - following the successful pattern
      const vespaDoc = {
        id: entry.id,
        section: entry.section || "",
        nlq: entry.nlq,
        jql: entry.jql,
        description: entry.description || "",
        query_summary: entry.summary || "",
        synonyms: entry.synonyms || [],
        paraphrases: entry.paraphrases || [],
        intents: entry.intents || [],
        jql_fields: entry.fields || [],
        entities: JSON.stringify(entry.entities || {}),
        entities_flat: [], // Will be populated from entities if needed
        product: Array.isArray(entry.product) ? entry.product : [entry.product || "Jira Core"],
        why: entry.why || "",
        notes: entry.notes || ""
      };
      
      // Extract flat entities for better text search
      if (entry.entities && typeof entry.entities === 'object') {
        const flatEntities = [];
        for (const [key, value] of Object.entries(entry.entities)) {
          if (Array.isArray(value)) {
            flatEntities.push(...value.map(v => `${key}:${v}`));
          } else {
            flatEntities.push(`${key}:${value}`);
          }
        }
        vespaDoc.entities_flat = flatEntities;
      }
      
      // Debug first document
      if (i === 0) {
        console.log(`  🔍 First document JSON:`, JSON.stringify({ fields: vespaDoc }, null, 2));
      }
      
      // Send to Vespa - using correct cluster and document type
      const response = await fetch('http://localhost:8080/document/v1/my_content/jql_query/docid/' + entry.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: vespaDoc })
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`HTTP ${response.status}: ${error}`);
      }
      
      successCount++;
      if (i % 20 === 0) {
        console.log(`  ✅ Ingested ${i + 1}/${jqlEntries.length} entries...`);
      }
      
    } catch (error) {
      console.error(`  ❌ Error ingesting entry ${entry.id}: ${error.message}`);
      errorCount++;
    }
  }
  
  console.log(`\n🎯 Ingestion Complete!`);
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Errors: ${errorCount}`);
  console.log(`  📊 Total: ${jqlEntries.length}`);
  
  // Wait a moment for indexing
  console.log('\n⏳ Waiting 3 seconds for indexing...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Verify ingestion
  try {
    const verifyResponse = await fetch('http://localhost:8080/search/?yql=select%20*%20from%20jql_query&hits=1');
    const verifyData = await verifyResponse.json();
    const totalCount = verifyData.root?.totalCount || 0;
    console.log(`✅ Verification: ${totalCount} documents indexed in Vespa`);
  } catch (error) {
    console.error(`❌ Verification failed: ${error.message}`);
  }
}

ingestJQLData().catch(console.error);