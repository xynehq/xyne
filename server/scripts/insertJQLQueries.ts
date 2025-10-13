import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function insertJQLQueries() {
  try {
    // Read the comprehensive merged data
    const dataPath = path.join(__dirname, '../data/dataToIngest.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const queries = JSON.parse(rawData);

    console.log(`Found ${queries.length} JQL queries to insert`);

    // Insert each query into Vespa
    for (const query of queries) {
      // Convert entities object to JSON string
      const vespaDoc = {
        ...query,
        entities: JSON.stringify(query.entities)
      };

      const response = await fetch(`http://localhost:8080/document/v1/my_content/jql_query/docid/${query.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: vespaDoc
        })
      });

      if (response.ok) {
        console.log(`✅ Inserted query ${query.id}: ${query.nlq}`);
      } else {
        const error = await response.text();
        console.error(`❌ Failed to insert query ${query.id}:`, error);
      }
    }

    console.log('✅ JQL queries insertion completed');
  } catch (error) {
    console.error('❌ Error inserting JQL queries:', error);
  }
}

insertJQLQueries();