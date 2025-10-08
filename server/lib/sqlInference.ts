import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { DuckDBQuery } from "@/types";
import { getProviderByModel } from "@/ai/provider"
import type { Models } from "@/ai/types"
import { type Message } from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "sqlInference",
})

/**
 * Combined function that classifies if a query is metric-related and generates SQL if it is
 * @param query The user's query to analyze
 * @param tableName The name of the table to query
 * @param schema The schema of the table
 * @param fewShotSamples Example rows for few-shot learning
 * @returns DuckDBQuery if metric-related, null if not
 */
export const analyzeQueryAndGenerateSQL = async (
  query: string,
  tableName: string,
  schema: string,
  fewShotSamples: string
): Promise<DuckDBQuery | null> => {
  const model : Models = config.sqlInferenceModel as Models
  if (!model) {
    Logger.warn("SQL inference model not set, returning null");
    return null;
  }
  Logger.debug(`Analyzing query and generating SQL`);

  const stripNoise = (s: string) => {
    let t = s.trim();
    // remove all code fences
    t = t.replace(/```(?:json)?/gi, "").replace(/```/g, "");
    // remove leading/trailing non-JSON text
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
    return t.trim();
  };

  const prompt = `You are a query analyzer and DuckDB SQL generator.

First, determine if the user is asking for metrics/statistics/numerical data.
- Metric-related queries: count, counts, sums, averages, KPIs, financial figures, quantitative analysis
- Non-metric queries: descriptive information, definitions, qualitative info, names, categories, context, text-only attributes

If the query is NOT metric-related, respond with: {"isMetric": false, "sql": null, "notes": "Query is not metric-related"}

If the query IS metric-related, generate DuckDB SQL following this schema:
{
  "isMetric": true,
  "sql": "SELECT ...",
  "notes": "brief reasoning in 1-2 lines"
}

Rules for SQL generation:
- Target database: DuckDB (SQL dialect = DuckDB)
- Use ONLY the provided schema and column names. Do NOT invent fields
- Output a SINGLE statement. No CTEs with CREATE/INSERT/UPDATE/DELETE. SELECT-only
- Disallow: INSTALL, LOAD, PRAGMA, COPY, EXPORT, ATTACH, DETACH, CALL, CREATE/ALTER/DROP, SET/RESET
- Output must be a single-line minified JSON object. Do NOT include markdown, code fences, comments, or any prose
- If ambiguous, choose the simplest interpretation and state the assumption in "notes"

Context:
- User question: ${query}
- Available tables and columns with types and short descriptions:
table name: ${tableName}
schema: ${schema}
- Example rows (up to 5 per table; strings truncated):
${fewShotSamples}`;

  try {
    const provider = getProviderByModel(model);
    
    const messages: Message[] = [
      {
        role: "user",
        content: [{ text: prompt }]
      }
    ]

    const modelParams = {
      modelId: model,
      temperature: 0.1,
      max_new_tokens: 512,
      stream: false,
      systemPrompt: "You are a helpful assistant that analyzes queries and generates SQL when appropriate."
    }

    const response = await provider.converse(messages, modelParams);
    const responseText = response.text || "";
    
    const cleaned = stripNoise(responseText);
    let parsedResponse: { isMetric: boolean; sql: string | null; notes: string };
    
    try {
      parsedResponse = JSON.parse(cleaned);
    } catch (e) {
      Logger.error("Failed to parse cleaned LLM response as JSON", { cleaned });
      throw e;
    }

    if (!parsedResponse.isMetric) {
      Logger.debug(`Query is not metric-related: ${parsedResponse.notes}`);
      return null;
    }

    if (!parsedResponse.sql) {
      Logger.warn("LLM indicated metric query but provided no SQL");
      return null;
    }

    const result: DuckDBQuery = {
      sql: parsedResponse.sql,
      notes: parsedResponse.notes
    };

    return result;
  } catch (error) {
    Logger.error("Failed to analyze query and generate SQL:", error);
    return null;
  }
}


