import { processJiraQueryRequest } from '../integrations/jira/jqlQueryGeneration.js';

async function testSingleQuery() {
  const query = "Show me bugs assigned to John created last week";
  
  console.log('🧪 Testing Single JQL Generation\n');
  console.log(`Testing: "${query}"`);
  console.log('='.repeat(60));
  
  try {
    const result = await processJiraQueryRequest(query);
    
    console.log('\n📊 Results:');
    console.log(`User Query: ${result.userQuery}`);
    console.log(`Found Examples: ${result.relevantExamples.length}`);
    console.log(`Generated JQL: ${result.generatedJQL}`);
    
    console.log('\n📚 Relevant Examples Found:');
    result.relevantExamples.forEach((example, index) => {
      console.log(`\n${index + 1}. ${example.nlq}`);
      console.log(`   JQL: ${example.jql}`);
      console.log(`   Description: ${example.description}`);
      console.log(`   Fields: ${example.fields.join(', ')}`);
    });
    
  } catch (error) {
    console.error(`❌ Error:`, error);
  }
}

testSingleQuery().catch(console.error);