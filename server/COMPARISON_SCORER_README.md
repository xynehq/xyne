# Comparison Scorer - API vs Tool Revamp Agentic Answers

## Overview

Created a comprehensive comparison evaluation system that scores and compares API vs Tool Revamp agentic answers against ground truth using only **Factuality** and **Completeness** metrics.

## Key Features

### ✅ Simplified Scoring Criteria
- **Removed** DomainRelevance and SemanticSimilarity 
- **Focused** only on Factuality (1-10) and Completeness (1-10)
- Each score is an integer with detailed justification

### ✅ Dual Input Processing
- **API Agentic Answers**: `/Users/telkar.varasree/Downloads/xyne/server/api_agentic_answers.json`
- **Tool Revamp Agentic**: `/Users/telkar.varasree/Downloads/xyne/server/tool_revamp_agentic.json`
- Automatically matches questions between files

### ✅ Comprehensive Comparison Analysis
- **Individual Scores**: Both API and Tool Revamp answers scored separately
- **Winner Determination**: Overall, Factuality, and Completeness winners
- **Detailed Assessment**: 2-3 sentence comparison summary
- **Key Differences**: 3-5 specific differences between answers

## Output Format

```json
{
  "results": [
    {
      "User_data": { "UserID": "...", "User_name": "..." },
      "Question_weights": { "Coverage_preference": "...", "Vagueness": 0, ... },
      "Question": "...",
      "Answer_weights": { "Factuality": 1, "Completeness": 1, "Domain_relevance": 1 },
      "Answer": "...", // Ground Truth
      "Confidence": 1,
      "old_Agentic_answer": "...", // From api_agentic_answers.json
      "new_Agentic_answer": "...", // From tool_revamp_agentic.json
      "old_score": {
        "Factuality": 8,
        "Completeness": 7,
        "Reason": "Factuality scored 8 because most technical details match ground truth with minor naming differences. Completeness scored 7 as it covers main categories but omits specific incident emails.",
        "Insights": "MISSING TRUTH: Omits email references. DEVIATIONS: Uses different terminology. OVERALL: Captures risk landscape but lacks specific incident details."
      },
      "new_score": {
        "Factuality": 6,
        "Completeness": 5,
        "Reason": "Factuality scored 6 due to some categories not matching ground truth exactly. Completeness scored 5 because several ground-truth categories are omitted while new ones are introduced.",
        "Insights": "MISSING TRUTH: Omits key categories from ground truth. ADDITIONAL CONTEXT: Introduces new categories not in ground truth. OVERALL: Different categorization approach reduces alignment."
      },
      "comparison": {
        "better_answer": "old",
        "factuality_winner": "old", 
        "completeness_winner": "old",
        "overall_assessment": "The old answer provides better factual accuracy and completeness compared to ground truth. The old answer aligns more closely with the ground truth categories.",
        "key_differences": "1) Old answer follows ground truth categorization more closely. 2) New answer introduces different categories. 3) Old answer includes more technical details."
      }
    }
  ]
}
```

## Usage Instructions

### Command Line Interface
```bash
# Use default files
bun run comparison_scorer.ts

# Specify custom files
bun run comparison_scorer.ts [oldEvalFile] [newEvalFile] [outputFile]

# Show help
bun run comparison_scorer.ts --help
```

### Default File Paths
- **Old Eval**: `old_agentic_eval.json`
- **New Eval**: `tool_revamp_eval_2.json`
- **Output**: `comparison_results.json`

## Scoring Methodology

### Factuality (1-10)
- **Score 10**: Zero contradictions with ground truth, all overlapping information accurate
- **Score 7-9**: No direct contradictions, minor deviations in presentation but same core facts
- **Score 4-6**: Mix of accurate and inaccurate information, some contradictions on secondary points
- **Score 1-3**: Significant factual errors, direct contradictions on core information

### Completeness (1-10)
- **Score 10**: Addresses every element mentioned in ground truth, no significant omissions
- **Score 7-9**: Covers all major points, minor gaps in supporting details
- **Score 4-6**: Addresses main question but misses important elements
- **Score 1-3**: Major gaps in addressing the question, superficial treatment

### Comparison Logic
- **Better Answer**: Calculate average score: (Factuality + Completeness) / 2
  - Difference ≥ 1.0: Clear winner
  - Difference 0.5-0.9: Slight winner
  - Difference < 0.5: Tie

## Processing Details

### Batch Processing
- **Batch Size**: 2 items per batch (for reliable JSON parsing)
- **Retry Logic**: 3 attempts per batch with exponential backoff
- **Intermediate Saves**: Results saved after each batch
- **Error Handling**: Default scores applied for failed evaluations

### Data Matching
- Questions matched by exact text comparison between old and new files
- Only matching questions are processed for comparison
- Unmatched questions are logged as warnings

### Statistics Generated
- Overall comparison results (Old Wins / New Wins / Ties)
- Factor-specific winners (Factuality and Completeness)
- Average scores for old vs new answers
- Percentage breakdowns of performance

## Technical Implementation

### Architecture
- **TypeScript**: Full type safety with interfaces
- **Modular Design**: Separate functions for each processing stage
- **Error Recovery**: Graceful handling of API failures
- **Progress Tracking**: Detailed logging of processing status

### API Integration
- **Model**: `azure_ai/gpt-oss-120b`
- **Temperature**: 0.1 (for consistent scoring)
- **Max Tokens**: 8000
- **Response Format**: JSON object

### File Structure
```
/server/
├── comparison_scorer.ts      # Main comparison script
├── old_agentic_eval.json    # Old answers input
├── tool_revamp_eval_2.json  # New answers input  
└── comparison_results.json   # Generated comparison output
```

## Validation Results

### Test Run Status ✅
- Successfully processed first 4 comparison items
- Proper JSON output format validated
- Individual and comparison scores generated correctly
- File matching and data extraction working properly

### Expected Output
- **100 comparison items** (matching questions from both files)
- **Detailed scoring** for each old/new answer pair
- **Comprehensive statistics** on performance differences
- **Actionable insights** for answer quality improvement

## Next Steps

1. **Complete Full Run**: Process all 100 comparison items
2. **Analyze Results**: Review which answers perform better overall
3. **Generate Report**: Create summary of findings and recommendations
4. **Optimize Based on Results**: Use insights to improve answer generation

## Key Benefits

✅ **Focused Evaluation**: Only Factuality and Completeness metrics
✅ **Direct Comparison**: Side-by-side old vs new answer analysis  
✅ **Actionable Insights**: Specific reasons for score differences
✅ **Comprehensive Stats**: Overall performance comparison
✅ **Robust Processing**: Error handling and retry logic
✅ **Incremental Saves**: Progress preserved during processing