import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function normalizeJQLQueries() {
  try {
    // Read the current data
    const dataPath = path.join(__dirname, '../data/sample-jql-queries.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const queries = JSON.parse(rawData);

    console.log(`Processing ${queries.length} JQL queries for normalization`);

    // Normalize each query
    const normalizedQueries = queries.map((query: any) => {
      const normalized: any = {
        id: query.id,
        section: query.section,
        nlq: query.nlq,
        jql: query.jql,
        description: query.description,
        query_summary: query.query_summary || query.summary || `Natural query: '${query.nlq}'. This JQL: ${query.jql}. Purpose: ${query.why || query.description}`,
        synonyms: query.synonyms || [],
        paraphrases: query.paraphrases || [],
        intents: query.intents || [],
        fields: query.fields || [],
        entities: query.entities || {},
        product: Array.isArray(query.product) ? query.product : [query.product || "Jira Core"],
        why: query.why || query.description,
        notes: query.notes || ""
      };

      return normalized;
    });

    // Write back the normalized data
    fs.writeFileSync(dataPath, JSON.stringify(normalizedQueries, null, 2));
    console.log(`✅ Normalized ${normalizedQueries.length} JQL queries`);

  } catch (error) {
    console.error('❌ Error normalizing JQL queries:', error);
  }
}

normalizeJQLQueries();