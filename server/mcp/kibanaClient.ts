import axios from "axios";
import type { AxiosInstance } from "axios";
import { getLogger } from "../logger/index.js";
import { Subsystem } from "../types.js";

export interface KibanaSearchPayload {
  start_time: string;
  end_time: string;
  query_terms?: string[];
  or_terms?: string[];
  not_terms?: string[];
  max_results?: number;
  response_format?: "concise" | "detailed";
  max_tokens?: number;
}

export interface KibanaSearchResult {
  status: string;
  data: any[];
  metadata: {
    original_count: number;
    returned_count: number;
    total_tokens: number;
    was_truncated: boolean;
    max_results_used: number;
    attempt_number: number;
  };
}

export default class KibanaClient {
  private client: AxiosInstance;
  private logger = getLogger(Subsystem.MCP);
  private baseUrl: string;
  private preference: string;

  constructor(baseUrl: string, cookie: string, preference?: string) {
    // Input validation
    if (!baseUrl || typeof baseUrl !== "string") {
      throw new Error("Invalid baseUrl: must be a non-empty string");
    }
    if (!cookie || typeof cookie !== "string") {
      throw new Error("Invalid cookie: must be a non-empty string");
    }

    this.baseUrl = baseUrl;
    this.preference = preference || "1747373756456";

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "osd-xsrf": "osd-fetch",
        "osd-version": "2.15.0",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        origin: baseUrl,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        cookie: cookie,
      },
    });
  }

  private countTokens(text: string): number {
    // Simple token counting - divide by 4 as approximation
    return Math.ceil(text.length / 4);
  }

  private truncateResultsByTokens(
    results: any[],
    maxTokens: number = 50000,
    responseFormat: string = "concise"
  ): { truncatedResults: any[]; totalTokens: number; wasTruncated: boolean } {
    if (!results || results.length === 0) {
      return { truncatedResults: results, totalTokens: 0, wasTruncated: false };
    }

    const truncatedResults: any[] = [];
    let totalTokens = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const resultStr =
        typeof result === "object" ? JSON.stringify(result) : String(result);
      const resultTokens = this.countTokens(resultStr);

      if (totalTokens + resultTokens > maxTokens) {
        this.logger.info(
          `Token limit reached. Truncating results at index ${i}/${results.length}`
        );
        this.logger.info(
          `Current tokens: ${totalTokens}, Result tokens: ${resultTokens}, Max: ${maxTokens}`
        );
        return { truncatedResults, totalTokens, wasTruncated: true };
      }

      truncatedResults.push(result);
      totalTokens += resultTokens;
    }

    return { truncatedResults, totalTokens, wasTruncated: false };
  }

  private buildQuery(payload: KibanaSearchPayload) {
    const { query_terms = [], or_terms = [], not_terms = [] } = payload;

    const filterConditions = query_terms.map((term) => ({
      multi_match: {
        type: "phrase",
        query: term,
        lenient: true,
      },
    }));

    const shouldConditions = or_terms.map((term) => ({
      multi_match: {
        type: "phrase",
        query: term,
        lenient: true,
      },
    }));

    const mustNotConditions = not_terms.map((term) => ({
      multi_match: {
        type: "phrase",
        query: term,
        lenient: true,
      },
    }));

    const boolQuery: any = {
      bool: {
        must: [],
        filter: [
          {
            range: {
              timestamp: {
                gte: payload.start_time,
                lte: payload.end_time,
                format: "strict_date_optional_time",
              },
            },
          },
        ],
        should: [],
        must_not: [],
      },
    };

    if (filterConditions.length > 0) {
      boolQuery.bool.filter.push({
        bool: {
          filter: filterConditions,
        },
      });
    }

    if (shouldConditions.length > 0) {
      boolQuery.bool.should = shouldConditions;
      if (shouldConditions.length > 0 && filterConditions.length === 0) {
        boolQuery.bool.minimum_should_match = 1;
      }
    }

    if (mustNotConditions.length > 0) {
      boolQuery.bool.must_not = mustNotConditions;
    }

    return boolQuery;
  }

  async searchLogs(payload: KibanaSearchPayload): Promise<KibanaSearchResult> {
    // Input validation
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload: must be an object");
    }

    // Validate required fields
    const requiredFields = ["start_time", "end_time"];
    const missingFields = requiredFields.filter(
      (field) => !payload[field as keyof KibanaSearchPayload]
    );

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(", ")}`);
    }

    // Validate time format (ISO 8601)
    const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    if (!timePattern.test(payload.start_time)) {
      throw new Error(
        "Invalid start_time format: must be ISO 8601 (YYYY-MM-DDTHH:mm:ss)"
      );
    }
    if (!timePattern.test(payload.end_time)) {
      throw new Error(
        "Invalid end_time format: must be ISO 8601 (YYYY-MM-DDTHH:mm:ss)"
      );
    }

    // Validate time range
    const startTime = new Date(payload.start_time);
    const endTime = new Date(payload.end_time);
    if (startTime >= endTime) {
      throw new Error("Invalid time range: start_time must be before end_time");
    }

    const { query_terms = [], or_terms = [], not_terms = [] } = payload;

    // Validate that arrays are actually arrays
    if (
      !Array.isArray(query_terms) ||
      !Array.isArray(or_terms) ||
      !Array.isArray(not_terms)
    ) {
      throw new Error("query_terms, or_terms, and not_terms must be arrays");
    }

    if (!query_terms.length && !or_terms.length && !not_terms.length) {
      throw new Error(
        "At least one of query_terms, or_terms, or not_terms must be provided"
      );
    }

    const maxResults = payload.max_results || 500;
    const responseFormat = payload.response_format || "concise";
    const maxTokens = payload.max_tokens || 50000;

    // Validate numeric parameters
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new Error("max_results must be a positive integer");
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error("max_tokens must be a positive integer");
    }

    if (!["concise", "detailed"].includes(responseFormat)) {
      throw new Error(
        "Invalid response_format. Must be 'concise' or 'detailed'."
      );
    }

    try {
      // Progressive reduction strategy
      const attempts = [
        maxResults,
        Math.floor(maxResults / 2),
        Math.floor(maxResults / 4),
        Math.floor(maxResults / 8),
        Math.min(50, maxResults),
      ].filter((a) => a > 0);

      for (let attemptNum = 0; attemptNum < attempts.length; attemptNum++) {
        const currentMaxResults = attempts[attemptNum];

        try {
          this.logger.info(
            `Kibana search attempt ${
              attemptNum + 1
            }: Trying with max_results=${currentMaxResults}`
          );

          const boolQuery = this.buildQuery(payload);

          const searchPayload = {
            params: {
              index: "ardra-logs*",
              body: {
                sort: [
                  { timestamp: { order: "desc", unmapped_type: "boolean" } },
                ],
                size: currentMaxResults,
                version: true,
                aggs: {
                  "2": {
                    date_histogram: {
                      field: "timestamp",
                      fixed_interval: "30m",
                      time_zone: "Asia/Calcutta",
                      min_doc_count: 1,
                    },
                  },
                },
                stored_fields: ["*"],
                script_fields: {},
                docvalue_fields: [{ field: "timestamp", format: "date_time" }],
                _source: { excludes: [] },
                query: boolQuery,
                highlight: {
                  pre_tags: ["@opensearch-dashboards-highlighted-field@"],
                  post_tags: ["@/opensearch-dashboards-highlighted-field@"],
                  fields: { "*": {} },
                  fragment_size: 2147483647,
                },
              },
              preference: parseInt(this.preference),
            },
          };

          this.logger.debug(
            `Query structure: ${JSON.stringify(boolQuery, null, 2)}`
          );

          const response = await this.client.post(
            "/_dashboards/internal/search/opensearch-with-long-numerals",
            searchPayload
          );

          this.logger.info(`Kibana response status: ${response.status}`);
          this.logger.info(
            `Kibana response length: ${JSON.stringify(response.data).length}`
          );

          const searchResults = response.data;
          const processedResults: any[] = [];

          const hits = searchResults?.rawResponse?.hits?.hits || [];

          for (const hit of hits) {
            if (responseFormat === "detailed") {
              if (hit._source) {
                processedResults.push(hit._source);
              } else {
                processedResults.push(hit);
              }
            } else {
              // concise
              if (hit._source) {
                const source = hit._source;
                if (source.message) {
                  processedResults.push(source.message);
                } else {
                  processedResults.push({ _source_without_message: source });
                }
              } else {
                processedResults.push({ _hit_without_source: hit });
              }
            }
          }

          this.logger.info(
            `Kibana search results (format: ${responseFormat}): ${JSON.stringify(
              processedResults.slice(0, 3)
            )}...`
          );

          const { truncatedResults, totalTokens, wasTruncated } =
            this.truncateResultsByTokens(
              processedResults,
              maxTokens,
              responseFormat
            );

          this.logger.info(
            `Results: ${processedResults.length} -> ${truncatedResults.length} (tokens: ${totalTokens})`
          );

          if (!wasTruncated || attemptNum === attempts.length - 1) {
            return {
              status: "success",
              data: truncatedResults,
              metadata: {
                original_count: processedResults.length,
                returned_count: truncatedResults.length,
                total_tokens: totalTokens,
                was_truncated: wasTruncated,
                max_results_used: currentMaxResults,
                attempt_number: attemptNum + 1,
              },
            };
          } else {
            this.logger.info(
              "Results were truncated, trying with fewer max_results"
            );
            continue;
          }
        } catch (error: any) {
          if (axios.isAxiosError(error)) {
            const statusCode = error.response?.status || "Unknown";
            const errorContent = error.response?.data || error.message;
            this.logger.error(
              `HTTP Error calling Kibana API: ${statusCode} - ${JSON.stringify(
                errorContent
              )}`
            );

            if (attemptNum === attempts.length - 1) {
              throw new Error(
                `Kibana API Error (${statusCode}): ${JSON.stringify(
                  errorContent
                )}`
              );
            } else {
              this.logger.info("Retrying with fewer results due to HTTP error");
              continue;
            }
          } else {
            this.logger.error(`Error during Kibana API call: ${error.message}`);

            if (attemptNum === attempts.length - 1) {
              throw new Error(`Failed to search Kibana logs: ${error.message}`);
            } else {
              this.logger.info(
                `Retrying with fewer results due to error: ${error.message}`
              );
              continue;
            }
          }
        }
      }
      throw new Error("All attempts to search Kibana logs failed");
    } catch (error) {
      this.logger.error("Kibana search failed:", error);
      throw new Error(`Kibana search failed: ${(error as Error).message}`);
    }
  }
}
