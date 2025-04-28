# Search Quality Evaluation Script (`evaluateSearchQuality.ts`)

This script is designed to evaluate the quality and relevance of search results provided by the Vespa search engine integration.

## Purpose

The primary goal of this script is to quantitatively measure the effectiveness of the search ranking for different types of documents (files, emails, users, events, attachments). It helps answer the question: "When searching for a specific item using a query derived from its content (e.g., its title), how highly is that item ranked in the search results?"

This is useful for:

*   **Benchmarking:** Establishing a baseline for search performance.
*   **Regression Testing:** Ensuring that changes to the search schema, ranking functions, or indexing pipeline do not negatively impact relevance.
*   **Tuning:** Comparing different search strategies or ranking profiles to identify improvements.
*   **Failure Analysis:** Automatically identifying patterns in searches that perform poorly (when debugging is enabled).

## How it Works

1.  **Selects Random Documents:** It fetches a configurable number (`NUM_SAMPLES`) of random documents from the Vespa index across different schemas (defined in `schemaFieldMap`).
2.  **Generates Search Queries:** For each document, it generates a search query based on a selected `EvaluationStrategy` (e.g., using the exact title, a phrase from the body, or random words from the title).
3.  **Performs Search:** It executes the generated query against the Vespa search endpoint, simulating a user search.
4.  **Finds Rank:** It checks the search results to determine the rank (position) of the original document used to generate the query.
5.  **Calculates Metrics:** It aggregates the ranks across all samples to calculate standard information retrieval metrics, including:
    *   Mean Reciprocal Rank (MRR)
    *   Success Rate @ K (e.g., Success@3, Success@5, Success@10 - the percentage of documents found within the top K results)
    *   Mean and Median Rank (for found documents)
    *   Rank Distribution
6.  **Reports Results:** It logs the overall metrics, metrics broken down by document schema, and saves detailed results and summaries to JSON and text files in the `server/eval-results/search-quality` directory.
7.  **(Optional) Failure Analysis:** If run with `DEBUG_POOR_RANKINGS=true`, it also:
    *   Saves detailed debug information (`debug_*.json`) for each document not found or ranked above `POOR_RANK_THRESHOLD`.
    *   Analyzes these failures to identify common issues (e.g., tokenization, term weighting).
    *   Generates a `search_failure_analysis.md` report summarizing the findings and providing recommendations.

## How to Run

The script is executed using `bun`. You **must** provide the email address of a user for whom the search permissions should be evaluated.

```bash
# Basic usage (calculates metrics only):
EVALUATION_USER_EMAIL="user@example.com" bun run server/scripts/evaluateSearchQuality.ts

# Run with failure analysis enabled:
EVALUATION_USER_EMAIL="user@example.com" \
DEBUG_POOR_RANKINGS=true \
bun run server/scripts/evaluateSearchQuality.ts

# Example with a specific strategy and more samples:
EVALUATION_USER_EMAIL="user@example.com" \
EVALUATION_STRATEGY="BodyPhrase" \
NUM_SAMPLES=200 \
DEBUG_POOR_RANKINGS=true \
bun run server/scripts/evaluateSearchQuality.ts
```

### Environment Variables

*   `EVALUATION_USER_EMAIL` ( **Required**): The email address to use for permission-aware search.
*   `EVALUATION_STRATEGY` (Optional): The strategy to use for generating queries. Defaults to `ExactTitle`. Available strategies are defined in the `EvaluationStrategy` enum within the script (e.g., `ExactTitle`, `BodyPhrase`, `RandomTitleWords`).
*   `NUM_SAMPLES` (Optional): The number of documents to sample and evaluate. Defaults to `100`.
*   `EVALUATION_NUM_RUNS` (Optional): The number of evaluation runs to perform. Metrics are averaged across these runs. Defaults to `3`.
*   `MAX_RANK_TO_CHECK` (Optional): The maximum rank position to check when searching for the target document. Defaults to `100`.
*   `DELAY_MS` (Optional): Delay in milliseconds between search requests. Defaults to `15`.
*   `ENABLE_TRACE` (Optional): Set to `true` to include Vespa trace information in logs (can be verbose). Defaults to `false`. `DEBUG_POOR_RANKINGS=true` implicitly enables tracing for failed searches.
*   `DEBUG_POOR_RANKINGS` (Optional): Set to `true` to enable detailed failure analysis. This will save individual `debug_*.json` files for poorly ranked documents and generate a `search_failure_analysis.md` report at the end. Defaults to `false`.
*   `POOR_RANK_THRESHOLD` (Optional): The rank threshold above which a result is considered "poor" for debugging and failure analysis when `DEBUG_POOR_RANKINGS` is true. Defaults to `10`.
*   `EVALUATION_DELAY_MS` (Optional): Alias for `DELAY_MS`. Defaults to `15`.

## Output Files

All output files are saved in the `server/eval-results/search-quality/` directory relative to the project root.

*   `evaluation_results_[STRATEGY]_[TIMESTAMP].json`: Detailed results for each sampled document (rank, schema, title).
*   `performance_summary_[STRATEGY]_[TIMESTAMP].txt`: Text file summarizing overall and per-schema metrics.
*   `poor_rankings_[STRATEGY]_[TIMESTAMP].json`: (If any poor rankings found) JSON containing only the results for documents ranked > `POOR_RANK_THRESHOLD` or not found.
*   `debug_[HASH]_[TIMESTAMP].json`: (If `DEBUG_POOR_RANKINGS=true`) Individual debug files for each poorly ranked document, containing detailed trace and top result info.
*   `search_failure_analysis.md`: (If `DEBUG_POOR_RANKINGS=true`) Markdown report summarizing failure patterns and providing recommendations. 