import fetch from 'node-fetch';
import { getProviderByModel } from '@/ai/provider';
import { Models } from '@/ai/types';

interface JQLExample {
  id: string;
  nlq: string;
  jql: string;
  description: string;
  query_summary: string;
  synonyms: string[];
  paraphrases: string[];
  intents: string[];
  fields: string[];
  entities: any;
  product: string[];
  why: string;
  notes: string;
}

interface VespaSearchResult {
  root: {
    children: Array<{
      fields: JQLExample;
      relevance: number;
    }>;
  };
}

/**
 * Search Vespa for relevant JQL examples based on user query
 */
export async function searchRelevantJQLExamples(userQuery: string, limit: number = 5): Promise<JQLExample[]> {
  try {
    const searchUrl = `http://localhost:8080/search/`;
    
    // Extract key terms for text search
    const searchTerms = userQuery.toLowerCase()
      .split(' ')
      .filter(term => term.length > 2 && !['the', 'and', 'or', 'in', 'to', 'for', 'with', 'from'].includes(term))
      .slice(0, 3); // Take first 3 meaningful terms
    
    // Build search conditions for each term
    const conditions = searchTerms.map(term => 
      `nlq contains "${term}" OR query_summary contains "${term}" OR description contains "${term}"`
    ).join(' OR ');
    
    // Use text search first, then try hybrid if available
    const yql = `select * from jql_query where ${conditions}`;
    
    const searchParams = new URLSearchParams({
      yql: yql,
      hits: limit.toString(),
      'ranking.profile': 'hybrid'
    });

    console.log(`Searching with YQL: ${yql}`);
    
    const response = await fetch(`${searchUrl}?${searchParams}`);
    
    if (!response.ok) {
      // Fallback to simple text search if hybrid fails
      const fallbackConditions = searchTerms.map(term => 
        `nlq contains "${term}"`
      ).join(' OR ');
      const fallbackYql = `select * from jql_query where ${fallbackConditions}`;
      const fallbackParams = new URLSearchParams({
        yql: fallbackYql,
        hits: limit.toString()
      });
      
      console.log(`Hybrid search failed, trying fallback: ${fallbackYql}`);
      const fallbackResponse = await fetch(`${searchUrl}?${fallbackParams}`);
      
      if (!fallbackResponse.ok) {
        throw new Error(`Vespa search failed: ${fallbackResponse.statusText}`);
      }
      
      const fallbackResult: VespaSearchResult = await fallbackResponse.json() as VespaSearchResult;
      
      console.log(`Fallback found ${fallbackResult.root.children?.length || 0} results`);
      
      if (!fallbackResult.root.children || fallbackResult.root.children.length === 0) {
        console.log('No fallback results found, returning empty array');
        return [];
      }
      
      return fallbackResult.root.children.map(child => child.fields);
    }

    const result: VespaSearchResult = await response.json() as VespaSearchResult;
    
    console.log(`Found ${result.root.children?.length || 0} results`);
    
    // Extract and return the JQL examples
    if (!result.root.children || result.root.children.length === 0) {
      console.log('No results found, returning empty array');
      return [];
    }
    
    return result.root.children.map(child => child.fields);
    
  } catch (error) {
    console.error('Error searching JQL examples:', error);
    throw new Error(`Failed to search JQL examples: ${error}`);
  }
}

/**
 * Generate JQL query using LLM with relevant examples
 */
export async function generateJQLFromUserQuery(
  userQuery: string, 
  examples: JQLExample[]
): Promise<string> {
  
  const prompt = `You are a JQL (Jira Query Language) expert. Generate a JQL query based on the user's natural language request and the provided examples.

User Query: "${userQuery}"

Relevant JQL Examples:
${examples.map((example, index) => `
Example ${index + 1}:
- Natural Language: ${example.nlq}
- JQL: ${example.jql}
- Description: ${example.description}
- Fields used: ${example.fields.join(', ')}
- Product: ${example.product.join(', ')}
`).join('\n')}

Instructions:
1. Analyze the user query to understand what they want to search for
2. Use the provided examples as reference for proper JQL syntax and patterns
3. Generate a valid JQL query that matches the user's intent
4. Only return the JQL query, no explanation

JQL Query:`;

  try {
    // Use VertexAI Claude provider instead of OpenAI
    const provider = getProviderByModel(Models.Vertex_Claude_3_5_Sonnet);
    
    const systemPrompt = 'You are a JQL expert. Generate only valid JQL queries based on user requests and examples. Return only the JQL query without any explanation.';

    const response = await provider.converse([
      {
        role: 'user',
        content: [{ text: prompt }]
      }
    ], {
      modelId: Models.Vertex_Claude_3_5_Sonnet,
      systemPrompt: systemPrompt,
      stream: false,
      max_new_tokens: 200,
      temperature: 0.1
    });

    const generatedJQL = response.text?.trim() || 'ERROR: No response from LLM';
    
    console.log(`🤖 LLM generated JQL: ${generatedJQL}`);
    return generatedJQL;
    
  } catch (error) {
    console.error('❌ LLM error:', error);
    return `ERROR: LLM failed - ${error}`;
  }
}

/**
 * Main function to process user query and generate JQL
 */
export async function processJiraQueryRequest(userQuery: string): Promise<{
  userQuery: string;
  relevantExamples: JQLExample[];
  generatedJQL: string;
}> {
  try {
    console.log(`Processing Jira query request: "${userQuery}"`);
    
    // Step 1: Search for relevant JQL examples
    console.log('🔍 Searching for relevant JQL examples...');
    const relevantExamples = await searchRelevantJQLExamples(userQuery, 5);
    
    console.log(`✅ Found ${relevantExamples.length} relevant examples`);
    relevantExamples.forEach((example, index) => {
      console.log(`  ${index + 1}. ${example.nlq} -> ${example.jql}`);
    });
    
    // Step 2: Generate JQL using LLM
    console.log('🤖 Generating JQL with LLM...');
    const generatedJQL = await generateJQLFromUserQuery(userQuery, relevantExamples);
    
    console.log(`✅ Generated JQL: ${generatedJQL}`);
    
    return {
      userQuery,
      relevantExamples,
      generatedJQL
    };
    
  } catch (error) {
    console.error('Error processing Jira query request:', error);
    throw new Error(`Failed to process query: ${error}`);
  }
}