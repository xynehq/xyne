// Enhanced JQL Generation with Two-Stage Validation
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

interface JQLGenerationResult {
  jql: string;
  confidence: number;
  validationIssues: string[];
  alternatives?: string[];
}

export class EnhancedJQLGenerator {
  private client: AnthropicVertex;
  
  constructor() {
    this.client = new AnthropicVertex({
      projectId: 'dev-ai-gamma',
      region: 'us-east5',
    });
  }

  async generateWithValidation(userQuery: string, vespaExamples: any[]): Promise<JQLGenerationResult> {
    // Stage 1: Generate primary JQL
    const primaryJQL = await this.generatePrimaryJQL(userQuery, vespaExamples);
    
    // Stage 2: Validate and suggest improvements
    const validation = await this.validateJQL(primaryJQL, userQuery, vespaExamples);
    
    // Stage 3: Generate alternatives if confidence is low
    const alternatives = validation.confidence < 80 
      ? await this.generateAlternatives(userQuery, vespaExamples, validation.issues)
      : [];

    return {
      jql: validation.improvedJQL || primaryJQL,
      confidence: validation.confidence,
      validationIssues: validation.issues,
      alternatives
    };
  }

  private async generatePrimaryJQL(userQuery: string, examples: any[]): Promise<string> {
    const prompt = `Generate JQL for: "${userQuery}"

CRITICAL PATTERN FIXES:
- Comment count: "comment > N" (NOT issueProperty[commentCount])  
- Attachment search: "attachments ~ 'file'" (NOT text ~)
- Epic stories: "Epic Link" field (NOT hasSubtasks)
- Empty fields: "field IS EMPTY" (NOT text !~)
- Status history: Use CHANGED TO/FROM with DURING
- Assignment changes: "assignee CHANGED DURING (timeframe)"

Examples: ${examples.map(e => `${e.nlq} → ${e.jql}`).join('\n')}

Return ONLY the JQL query:`;

    const response = await this.client.beta.messages.create({
      model: 'claude-3-5-sonnet-v2@20241022',
      max_tokens: 150,
      temperature: 0.1,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });

    return response.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
  }

  private async validateJQL(jql: string, userQuery: string, examples: any[]): Promise<{
    confidence: number;
    issues: string[];
    improvedJQL?: string;
  }> {
    const prompt = `Validate this JQL against user intent and examples:

User Query: "${userQuery}"
Generated JQL: "${jql}"

Examples: ${examples.map(e => `${e.nlq} → ${e.jql}`).join('\n')}

Check for these common errors:
1. Using issueProperty[commentCount] instead of "comment > N"
2. Using text ~ for attachment search instead of "attachments ~"  
3. Using hasSubtasks() for epic relationships instead of "Epic Link"
4. Using text !~ for empty field checks instead of "IS EMPTY"
5. Incorrect syntax not shown in examples

Return JSON:
{
  "confidence": 0-100,
  "issues": ["list of specific problems"],
  "improvedJQL": "corrected version if needed"
}`;

    const response = await this.client.beta.messages.create({
      model: 'claude-3-5-sonnet-v2@20241022',
      max_tokens: 300,
      temperature: 0.1,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });

    try {
      return JSON.parse(response.content.filter(c => c.type === 'text').map(c => c.text).join(''));
    } catch {
      return { confidence: 70, issues: ['Validation parse error'] };
    }
  }

  private async generateAlternatives(userQuery: string, examples: any[], issues: string[]): Promise<string[]> {
    const prompt = `Generate 2 alternative JQL approaches for: "${userQuery}"

Known issues to avoid: ${issues.join(', ')}
Examples: ${examples.slice(0, 10).map(e => `${e.nlq} → ${e.jql}`).join('\n')}

Return as JSON array: ["alt1", "alt2"]`;

    const response = await this.client.beta.messages.create({
      model: 'claude-3-5-sonnet-v2@20241022', 
      max_tokens: 200,
      temperature: 0.3,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });

    try {
      return JSON.parse(response.content.filter(c => c.type === 'text').map(c => c.text).join(''));
    } catch {
      return [];
    }
  }
}