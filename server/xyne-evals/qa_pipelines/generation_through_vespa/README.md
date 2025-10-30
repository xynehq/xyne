# Vespa-Based QA Generation Pipeline

This directory contains a complete QA generation pipeline that uses Vespa search to create question-answer pairs from document exports.

## Overview

The pipeline follows these steps:
1. **Extract document IDs** from `vespa_export.json`
2. **Randomly select** a document using the selector
3. **Generate filter query** from the selected document's body content
4. **Search Vespa** for relevant documents using the filter query
5. **Generate QA pairs** using the LLM with the relevant documents as context
6. **Evaluate and save** the results

## Files

- `master.ts` - Main orchestration script that coordinates the entire pipeline
- `selector.ts` - Simple random document selector
- `generator.ts` - LLM-based QA pair generation with Vertex AI
- `evaluator.ts` - Evaluation and filtering of generated QA pairs
- `dataStore.ts` - Shared data storage for document management
- `types.ts` - TypeScript type definitions

## Usage

### Prerequisites

1. Set up environment variables in `server/.env`:
   ```
   VERTEX_PROJECT_ID=your-gcp-project-id
   VERTEX_REGION=us-east5
   VERTEX_AI_MODEL=gemini-2.5-pro
   ```

2. Ensure the vespa export file exists at:
   ```
   server/xyne-evals/data/actual_data/vespa_export.json
   ```

3. Make sure you have the required dependencies installed and Vespa is running.

### Running the Pipeline

```bash
# Navigate to the pipeline directory
cd server/xyne-evals/qa_pipelines/generation_through_vespa

# Run the master script
npx tsx master.ts
```

Or from the server directory:
```bash
cd server
npx tsx xyne-evals/qa_pipelines/generation_through_vespa/master.ts
```

### Configuration

You can modify the following constants in `master.ts`:
- `RELEVANT_DOCS_LIMIT` - Number of documents to retrieve from Vespa (default: 20)
- `QA_PAIRS_PER_DOC` - Number of QA pairs to generate (default: 5)
- `TEST_EMAIL` - Email for Vespa queries (default: "oindrila@rbi.in")

## Output

The pipeline generates the following outputs:

1. **Main Results**: `output/vespa_qa_generation_[timestamp].json`
   - Complete pipeline results including metadata, selected document info, relevant documents, and QA pairs

2. **QA Pairs**: `output/vespa_qa_pairs.json`
   - Filtered QA pairs with confidence > 0.7
   - Includes citations and metadata

3. **Evaluation Summary**: `output/evaluation_summary.json`
   - Statistical analysis of generated QA pairs
   - Confidence, factuality, and complexity distributions

4. **LLM Outputs**: `../llm_outputs/[group_id].txt`
   - Raw LLM responses for debugging

## Pipeline Flow

```
vespa_export.json
    ↓
[Extract DocIDs] → List of all document IDs
    ↓
[Selector] → Randomly selected document ID
    ↓
[Create Body Map] → Map of docId → document body content
    ↓
[Generate Filter Query] → Extract key terms from selected document
    ↓
[Vespa Search] → Find relevant documents using filter query
    ↓
[Generator] → Create QA pairs using LLM + relevant documents
    ↓
[Evaluator] → Filter by confidence & save results
```

## Error Handling

- The pipeline includes retry logic for LLM calls with exponential backoff
- Vespa search failures fall back to using only the selected document
- JSON parsing errors are handled gracefully with fallback responses
- All errors are logged with appropriate context

## Customization

To adapt this pipeline for different use cases:

1. **Document Selection**: Modify `selector.ts` to implement different selection strategies
2. **Filter Query Generation**: Update the `generateFilterQuery` function in `master.ts`
3. **QA Generation**: Customize the prompt in `generator.ts`
4. **Evaluation Criteria**: Adjust the confidence threshold and evaluation logic in `evaluator.ts`

## Dependencies

- `@google-cloud/vertexai` - For LLM calls
- `@xyne/vespa-ts` - For Vespa search integration
- Standard Node.js modules (`fs`, `path`, etc.)

## Troubleshooting

1. **Authentication Issues**: Ensure GCP credentials are properly configured
2. **Vespa Connection**: Verify Vespa is running and accessible
3. **File Not Found**: Check that `vespa_export.json` exists at the specified path
4. **LLM Failures**: Check environment variables and GCP project permissions
