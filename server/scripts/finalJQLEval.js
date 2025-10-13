// Final JQL Evaluation - Pure automation: Query → Vespa → LLM → Evaluation LLM
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Comprehensive test queries using the new rich YQL approach
const testQueries = [
  "Which customer tickets breached the Time to resolution SLA this week?",
  "Show incidents where Time to first response SLA was missed yesterday.",
  "Find bugs reopened more than twice in the last month.",
  "Show epics in the ALPHA project without any linked stories.",
 
];

// Advanced Vespa search using rich YQL patterns
async function searchRelevantJQLExamples(userQuery) {
  const searchUrl = `http://localhost:8280/search/`;
  
  // Build rich YQL using Vespa's advanced patterns
  const yql = `
    select * from jql_query where
    (
      ({targetHits:15} userInput(@query))
      or
      ({targetHits:15} nearestNeighbor(embedding, q))
    )
  `;
  
  const searchParams = new URLSearchParams({
    yql: yql.trim(),
    query: userQuery,  // Pass raw query to Vespa
    "ranking.profile": "hybrid",
    "input.query(q)": "embed(@query)",
    hits: '15',
    format: 'json'
  });

  const response = await fetch(`${searchUrl}?${searchParams}`);
  
  if (!response.ok) {
    throw new Error(`Vespa search failed: ${response.status}`);
  }

  const data = await response.json();
  const examples = data.root?.children?.map(child => child.fields) || [];
  
  console.log(`  🔍 Vespa returned ${examples.length}/15 chunks`);
  console.log(`  📝 YQL: ${yql.trim()}`);
  console.log(`  🎯 Raw query: ${userQuery}`);
  return { examples, yql: yql.trim(), userQuery };
}

// LLM 1: Generate JQL from query + Vespa chunks
async function generateJQLWithLLM(userQuery, vespaChunks) {
  const client = new AnthropicVertex({
    projectId: 'dev-ai-gamma',
    region: 'us-east5',
  });

  const prompt = `Generate a JQL query for: "${userQuery}"

Retrieved JQL Examples (USE ONLY THESE PATTERNS):
${vespaChunks.map((chunk, i) => `${i+1}. ${chunk.nlq} → ${chunk.jql}`).join('\n')}

CRITICAL SYNTAX REQUIREMENTS:
1. ALWAYS use double quotes for field values: issuetype = "Bug" (not issuetype = Bug)
2. ALWAYS use double quotes for text values: status = "In Progress" (not status = In Progress)  
3. NEVER mix quote types - use ONLY double quotes throughout
4. ALWAYS match parentheses: every ( must have a closing )
5. Use only field names that appear in the retrieved examples
6. When in doubt about field names, use the closest field from the examples

STRICT GUARDRAILS - MUST FOLLOW:
1. ONLY use operators, functions, and field names that appear EXACTLY in the examples above
2. FORBIDDEN: Do not use any function not shown above
3. FORBIDDEN: Do not invent any new syntax patterns  
4. REQUIRED: Copy and combine existing patterns from the examples
5. REQUIRED: If exact functionality isn't available in examples, use the closest available pattern
6. REQUIRED: Every operator and function in your JQL must exist in at least one example above

CORRECT EXAMPLES:
✅ issuetype = "Bug" AND status = "Open"
✅ assignee IN membersOf("qa") 
✅ priority IN ("High", "Critical")
✅ resolution IS EMPTY

INCORRECT EXAMPLES:
❌ issuetype = Bug (missing quotes)
❌ status = 'Open' (wrong quote type)
❌ reopenCount > 2 (invalid field)

Return ONLY the JQL query with proper syntax:`;

  const response = await client.beta.messages.create({
    model: 'claude-3-5-sonnet-v2@20241022',
    max_tokens: 200,
    temperature: 0.1,
    system: 'You are a JQL expert with STRICT LIMITATIONS. You can ONLY use JQL operators, functions, and syntax that appear in the provided examples. You are FORBIDDEN from using any functions not shown in the examples. Copy and adapt existing patterns only.',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }]
  });

  const jql = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('').trim();
  
  console.log(`  🤖 Generated JQL: ${jql}`);
  return jql;
}

// LLM 2: Evaluate the generated JQL
async function evaluateJQLWithLLM(userQuery, generatedJQL) {
  const client = new AnthropicVertex({
    projectId: 'dev-ai-gamma',
    region: 'us-east5',
  });

  const prompt = `Evaluate this JQL query:

User Query: "${userQuery}"
Generated JQL: "${generatedJQL}"

Return JSON evaluation:
{
  "score": <1-10>,
  "correctness": <true/false>,
  "syntax_valid": <true/false>,
  "reasoning": "<explanation>"
}`;

  const response = await client.beta.messages.create({
    model: 'claude-3-5-sonnet-v2@20241022',
    max_tokens: 300,
    temperature: 0.1,
    system: 'You are a JQL evaluator. Return structured JSON assessments.',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }]
  });

  const evaluationText = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('').trim();
  
  try {
    const evaluation = JSON.parse(evaluationText);
    console.log(`  📊 Score: ${evaluation.score}/10 (${evaluation.correctness ? '✅' : '❌'})`);
    return evaluation;
  } catch (error) {
    console.warn(`  ⚠️  JSON parse failed: ${error.message}`);
    return {
      score: 0,
      correctness: false,
      syntax_valid: false,
      reasoning: `Parse error: ${error.message}`
    };
  }
}

// JIRA API validation function
async function validateJQLWithJIRA(jql) {
  try {
    // Mock JIRA endpoint - replace with actual JIRA instance
    const jiraUrl = 'https://your-jira-instance.atlassian.net';
    const searchUrl = `${jiraUrl}/rest/api/2/search`;
    
    // For now, we'll do basic syntax validation since we don't have JIRA credentials
    // In a real implementation, you'd make this API call:
    /*
    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer YOUR_JIRA_TOKEN',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: jql,
        maxResults: 1,  // Just test if query works
        fields: ['id']
      })
    });
    
    if (response.ok) {
      return { valid: true, error: null };
    } else {
      const error = await response.json();
      return { valid: false, error: error.errorMessages || 'Unknown error' };
    }
    */
    
    // Basic syntax validation for demo
    const basicValidation = validateJQLSyntax(jql);
    return basicValidation;
    
  } catch (error) {
    return { 
      valid: false, 
      error: `Validation error: ${error.message}` 
    };
  }
}

// Basic JQL syntax validation
function validateJQLSyntax(jql) {
  try {
    // Basic checks for common JQL syntax issues
    const issues = [];
    
    // Check for basic syntax patterns
    if (jql.includes('ERROR:')) {
      issues.push('Query generation failed');
    }
    
    // Check for unmatched quotes
    const singleQuotes = (jql.match(/'/g) || []).length;
    const doubleQuotes = (jql.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      issues.push('Unmatched single quotes');
    }
    if (doubleQuotes % 2 !== 0) {
      issues.push('Unmatched double quotes');
    }
    
    // Check for unmatched parentheses
    const openParens = (jql.match(/\(/g) || []).length;
    const closeParens = (jql.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      issues.push('Unmatched parentheses');
    }
    
    // Check for valid operators (basic set)
    const validOperators = ['=', '!=', '>', '<', '>=', '<=', '~', '!~', 'IN', 'NOT IN', 'IS', 'IS NOT', 'WAS', 'CHANGED'];
    const hasValidOperator = validOperators.some(op => jql.includes(op));
    
    if (!hasValidOperator && !jql.includes('ORDER BY')) {
      issues.push('No valid JQL operators found');
    }
    
    // Field validation is handled by LLM semantic check
    
    // Check for missing quotes around field values
    const fieldValuePatterns = [
      /issuetype\s*=\s*[A-Za-z][^"\s]*(?!\w*")/g,  // issuetype = Bug (should be "Bug")
      /status\s*=\s*[A-Za-z][^"\s]*(?!\w*")/g,     // status = Open (should be "Open")  
      /priority\s*=\s*[A-Za-z][^"\s]*(?!\w*")/g,   // priority = High (should be "High")
    ];
    
    fieldValuePatterns.forEach(pattern => {
      if (pattern.test(jql)) {
        issues.push('Missing quotes around field values');
      }
    });
    
    return {
      valid: issues.length === 0,
      error: issues.length > 0 ? issues.join('; ') : null
    };
    
  } catch (error) {
    return {
      valid: false,
      error: `Syntax validation failed: ${error.message}`
    };
  }
}

// Binary evaluation function
async function evaluateJQLBinary(userQuery, generatedJQL) {
  console.log(`  🔍 Validating JQL syntax...`);
  
  // Step 1: Basic syntax validation
  const syntaxValidation = await validateJQLWithJIRA(generatedJQL);
  
  if (!syntaxValidation.valid) {
    console.log(`  ❌ FAIL - Syntax Error: ${syntaxValidation.error}`);
    return {
      binary_score: 0,
      pass: false,
      reason: `Syntax Error: ${syntaxValidation.error}`,
      syntax_valid: false
    };
  }
  
  // Step 2: Semantic validation using LLM for quick assessment
  console.log(`  🤖 Checking semantic correctness...`);
  
  const client = new AnthropicVertex({
    projectId: 'dev-ai-gamma',
    region: 'us-east5',
  });

  const prompt = `Evaluate this JQL query for correctness:

User Query: "${userQuery}"
Generated JQL: "${generatedJQL}"

Check for:
1. Does the JQL accurately represent the user's intent?
2. Are all field names valid in standard JIRA? (issuetype, status, assignee, reporter, etc.)
3. Is the syntax correct for the JQL version being used?
4. Are operators used correctly with their respective fields?

Return only JSON:
{
  "correct": <true/false>,
  "reasoning": "<brief explanation of any issues found>"
}`;

  try {
    const response = await client.beta.messages.create({
      model: 'claude-3-5-sonnet-v2@20241022',
      max_tokens: 150,
      temperature: 0.1,
      system: 'You are a JQL expert. Return only valid JSON with true/false assessment.',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }]
    });

    const evaluationText = response.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('').trim();
    
    const evaluation = JSON.parse(evaluationText);
    const pass = syntaxValidation.valid && evaluation.correct;
    
    console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'} - ${evaluation.reasoning}`);
    
    return {
      binary_score: pass ? 1 : 0,
      pass: pass,
      reason: evaluation.reasoning,
      syntax_valid: syntaxValidation.valid
    };
    
  } catch (error) {
    console.log(`  ❌ FAIL - Evaluation Error: ${error.message}`);
    return {
      binary_score: 0,
      pass: false,
      reason: `Evaluation failed: ${error.message}`,
      syntax_valid: syntaxValidation.valid
    };
  }
}

// Main evaluation flow
async function runFinalEvaluation() {
  console.log('🎯 Final JQL Evaluation - Pure Automation');
  console.log('Flow: Query → Vespa (15 chunks) → LLM → JIRA API Validation → Binary Score\n');
  
  const results = [];
  const dataDir = path.join(__dirname, '../data');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  for (let i = 0; i < Math.min(10, testQueries.length); i++) {
    const query = testQueries[i];
    console.log(`\n[${i + 1}/${testQueries.length}] "${query}"`);
    
    try {
      // Step 1: Query → Vespa (15 chunks)
      const { examples: vespaChunks, yql } = await searchRelevantJQLExamples(query);
      
      // Step 2: Vespa chunks → LLM → JQL
      const generatedJQL = await generateJQLWithLLM(query, vespaChunks);
      
      // Step 3: Query + JQL → Binary Evaluation (Syntax + Semantic)
      const evaluation = await evaluateJQLBinary(query, generatedJQL);
      
      results.push({
        query_id: i + 1,
        user_query: query,
        yql_query: yql,
        vespa_chunks_found: vespaChunks.length,
        vespa_chunks: vespaChunks.map(chunk => ({
          nlq: chunk.nlq,
          jql: chunk.jql,
          description: chunk.description
        })),
        generated_jql: generatedJQL,
        binary_evaluation: evaluation,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.push({
        query_id: i + 1,
        user_query: query,
        yql_query: `ERROR: ${error.message}`,
        vespa_chunks_found: 0,
        vespa_chunks: [],
        generated_jql: `ERROR: ${error.message}`,
        binary_evaluation: {
          binary_score: 0,
          pass: false,
          reason: `System error: ${error.message}`,
          syntax_valid: false
        },
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(dataDir, `jql_evaluation_${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  
  // Simple query-JQL mapping as requested
  const simpleResults = {
    metadata: {
      title: "JQL Query Generation Results",
      total_queries: results.length,
      generated: new Date().toISOString(),
      description: "Natural language to JQL mapping via Vespa + LLM"
    },
    results: results.map(r => ({
      query: r.user_query,
      jql: r.generated_jql,
      pass: r.binary_evaluation.pass,
      binary_score: r.binary_evaluation.binary_score
    }))
  };
  
  const simpleResultsPath = path.join(dataDir, `simple_jql_mapping_${timestamp}.json`);
  fs.writeFileSync(simpleResultsPath, JSON.stringify(simpleResults, null, 2));
  
  // CSV output
  const csvContent = `Query,JQL,Binary_Score,Pass,Syntax_Valid,Vespa_Chunks\n${results.map(r => 
    `"${r.user_query}","${r.generated_jql}",${r.binary_evaluation.binary_score},${r.binary_evaluation.pass},${r.binary_evaluation.syntax_valid},${r.vespa_chunks_found}`
  ).join('\n')}`;
  const csvPath = path.join(dataDir, `jql_evaluation_${timestamp}.csv`);
  fs.writeFileSync(csvPath, csvContent);
  
  // Summary
  const successful = results.filter(r => !r.generated_jql.startsWith('ERROR'));
  const passCount = successful.filter(r => r.binary_evaluation.pass).length;
  const passRate = successful.length > 0 
    ? ((passCount / successful.length) * 100).toFixed(1)
    : '0.0';
  
  const syntaxValidCount = successful.filter(r => r.binary_evaluation.syntax_valid).length;
  const syntaxValidRate = successful.length > 0 
    ? ((syntaxValidCount / successful.length) * 100).toFixed(1)
    : '0.0';
  
  const avgVespaChunks = successful.length > 0
    ? (successful.reduce((sum, r) => sum + r.vespa_chunks_found, 0) / successful.length).toFixed(1)
    : '0.0';
  
  console.log(`\n✅ Pure Automation Complete!`);
  console.log(`📊 Files saved:`);
  console.log(`   - Detailed: ${outputPath}`);
  console.log(`   - Simple mapping: ${simpleResultsPath}`);
  console.log(`   - CSV: ${csvPath}`);
  console.log(`\n📈 Binary Evaluation Results:`);
  console.log(`   - Total Queries: ${results.length}`);
  console.log(`   - Successful Generation: ${successful.length}/${results.length}`);
  console.log(`   - Queries PASSED: ${passCount}/${successful.length} (${passRate}%)`);
  console.log(`   - Syntax Valid: ${syntaxValidCount}/${successful.length} (${syntaxValidRate}%)`);
  console.log(`   - Avg Vespa chunks: ${avgVespaChunks}`);
  
  console.log(`\n📋 Query → JQL Results (Binary Pass/Fail):`);
  results.forEach(r => {
    const status = r.binary_evaluation.pass ? '✅ PASS' : '❌ FAIL';
    console.log(`   "${r.user_query}"`);
    console.log(`   → ${r.generated_jql} (${status})`);
  });
  
  return results;
}

runFinalEvaluation().catch(console.error);