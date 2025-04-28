# Test Queries Documentation

## Overview
This directory contains test queries used for evaluating the AI system's performance. The evaluation framework uses these queries to measure factuality and accuracy of the system's responses.

## File Format
Test queries are stored in JSON files, where each query is represented as an object with two required fields:
- `input`: The query text that will be fed to the AI system
- `expected`: The expected response that will be used to evaluate the system's answers

Example format:
```json
[
  {
    "input": "what is my email",
    "expected": "user@gmail.com"
  }
]
```

## Guidelines for Creating Effective Test Queries

1. **Clarity & Specificity**: Make `input` queries clear and specific - ambiguous queries are hard to evaluate
2. **Factual Correctness**: The `expected` answer should be factually correct and concise
3. **Diversity**: Include a diverse range of query types (factual, temporal, personal, etc.)
4. **Edge Cases**: Consider adding edge cases to thoroughly test the system
5. **Personal Data**: For queries about personal data, ensure the expected answer matches the test user account
6. **Objectivity**: Avoid queries that have subjective or multiple correct answers
7. **Complexity Range**: Include both simple and complex queries to test different capabilities

## Example Query Types

- **Factual**: `{"input": "what is my email", "expected": "user@example.com"}`
- **Temporal**: `{"input": "when was my last meeting", "expected": "Yesterday at 3pm with Marketing team"}`
- **Personal**: `{"input": "what's my job title", "expected": "Senior Developer"}`
- **Data Search**: `{"input": "find emails about project alpha", "expected": "Found 3 emails from last week about project alpha"}`

## Usage

These test queries are automatically used by the evaluation system to measure performance. To add new queries, simply add new objects to the array while following the guidelines above.