import { processJiraQueryRequest } from '../integrations/jira/jqlQueryGeneration';

async function testJQLGeneration() {
  const testQueries = [
    "Show me bugs assigned to John created last week",
    "Find high priority stories in project ALPHA",
    "Get issues updated in the last 3 days",
    "Show me all open tasks assigned to the QA team",
    "Find bugs with story points greater than 8"
  ];

  console.log('🧪 Testing JQL Generation System\n');

  for (const query of testQueries) {
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Testing: "${query}"`);
      console.log(`${'='.repeat(60)}`);
      
      const result = await processJiraQueryRequest(query);
      
      console.log('\n📊 Results:');
      console.log(`User Query: ${result.userQuery}`);
      console.log(`Found Examples: ${result.relevantExamples.length}`);
      console.log(`Generated JQL: ${result.generatedJQL}`);
      
    } catch (error) {
      console.error(`❌ Error testing query "${query}":`, error);
    }
  }
}

// Run the test
testJQLGeneration().catch(console.error);