// Script to test user queries against Vespa JQL search system
const queries = [
  "Show me my tickets that are still not done.",
  "List all high or critical bugs that haven't been resolved.",
  "Find ALPHA project issues tagged with frontend or UI labels.",
  "What issues were created in the last 7 days by the automation bot?",
  "Show me high-priority issues in unreleased versions.",
  "Which backend issues have been open and untouched for more than 14 days?",
  "List all stories under epic ALPHA-123 that aren't completed.",
  "Show issues that have 10 or more watchers but aren't low priority.",
  "Which issues moved into \"In Progress\" after this week started?",
  "Find stories in the current sprint that don't have story points.",
  "List escalation-labeled tickets created in the last 30 days.",
  "Show bugs in BETA project that mention \"timeout\" in their text.",
  "What tasks are still open and due by the end of this week?",
  "Show issues reported by QA team this month.",
  "Find tasks without attachments that were updated in the last 10 days.",
  "Which \"Get IT Help\" requests are still unresolved?",
  "Show Acme Corp's open requests.",
  "Find bugs where the description contains NullPointerException.",
  "Which ALPHA bugs were marked as duplicates in the last 60 days?",
  "Show all open sprint issues that are high or critical priority.",
  "List unassigned stories or tasks created in the last 3 days.",
  "Which issues were fixed in released versions this month?",
  "Find open bugs labeled customer or sev1.",
  "Which medium-priority issues haven't been updated in the last 20 days?",
  "Show documentation tickets currently in review.",
  "In project GAMMA, find tasks not assigned to devs and still open.",
  "List flaky bugs or test issues.",
  "Which tickets are in progress or in review, unresolved, and touched in the last 5 days?",
  "Show unfinished stories under epic BETA-456.",
  "Find API bugs created in the last 2 weeks that are not yet done."
];

async function searchVespaForQuery(query: string, index: number) {
  try {
    console.log(`\n🔍 Query ${index + 1}: "${query}"`);
    
    // Extract key terms from the query for better matching
    const keywords = extractKeywords(query);
    console.log(`  🔑 Keywords: ${keywords.join(', ')}`);
    
    // Try multiple search strategies
    const searchStrategies = [
      // Strategy 1: Keyword search in text fields
      `select * from jql_query where userInput("${keywords.join(' ')}")`,
      // Strategy 2: Simple keyword match
      `select * from jql_query where nlq contains "${keywords[0]}" OR description contains "${keywords[0]}"`,
      // Strategy 3: Look for specific field types
      `select * from jql_query where ${buildFieldSearch(keywords)}`
    ];
    
    for (let strategyIndex = 0; strategyIndex < searchStrategies.length; strategyIndex++) {
      try {
        const searchQuery = encodeURIComponent(searchStrategies[strategyIndex]);
        const vespaUrl = `http://localhost:8080/search/?yql=${searchQuery}&hits=3`;
        
        const response = await fetch(vespaUrl);
        if (!response.ok) {
          continue; // Try next strategy
        }
        
        const data = await response.json();
        const hits = data.root?.children || [];
        
        if (hits.length > 0) {
          console.log(`  ✅ Found ${hits.length} relevant JQL patterns (Strategy ${strategyIndex + 1}):`);
          hits.forEach((hit: any, i: number) => {
            const fields = hit.fields;
            console.log(`    ${i + 1}. NLQ: "${fields.nlq}"`);
            console.log(`       JQL: ${fields.jql}`);
            console.log(`       Description: ${fields.description}`);
            if (fields.synonyms && fields.synonyms.length > 0) {
              console.log(`       Synonyms: ${fields.synonyms.join(', ')}`);
            }
            console.log("");
          });
          return; // Found results, stop trying other strategies
        }
      } catch (error) {
        continue; // Try next strategy
      }
    }
    
    console.log("  ❌ No matching JQL patterns found with any strategy");
    
  } catch (error) {
    console.error(`  ❌ Error searching for query "${query}": ${error.message}`);
  }
}

function extractKeywords(query: string): string[] {
  // Remove common words and extract meaningful terms
  const commonWords = ['show', 'me', 'my', 'list', 'all', 'find', 'what', 'which', 'that', 'are', 'is', 'in', 'the', 'and', 'or', 'have', 'been', 'still', 'not', 'with', 'by', 'to', 'for', 'from', 'under', 'than', 'more', 'less'];
  const words = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !commonWords.includes(word));
  
  return words.slice(0, 5); // Take first 5 meaningful words
}

function buildFieldSearch(keywords: string[]): string {
  // Build a search that looks for keywords in various fields
  const fieldSearches = keywords.map(keyword => 
    `nlq contains "${keyword}" OR description contains "${keyword}" OR jql contains "${keyword}"`
  );
  return fieldSearches.join(' OR ');
}

async function testAllQueries() {
  console.log('🚀 Testing 30 user queries against Vespa JQL search system...\n');
  
  for (let i = 0; i < queries.length; i++) {
    await searchVespaForQuery(queries[i], i);
    
    // Small delay to avoid overwhelming Vespa
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('\n🎯 Testing complete!');
}

testAllQueries().catch(console.error);