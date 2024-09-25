


// export const knowledgeGraphPrompt = `
// Concise Document Analysis for Knowledge Graph Extraction
// Analyze the given document and provide a JSON output with the following key information for knowledge graph construction:

// Document summary
// Main entities (people, organizations, locations, key terms)
// Important relationships between entities
// Key topics and themes
// Relevant dates and numerical data
// Document classification and metadata

// Use this JSON structure:
// {
//   "summary": "string",
//   "entities": {
//     "people": ["string"],
//     "organizations": ["string"],
//     "locations": ["string"],
//     "keyTerms": ["string"]
//   },
//   "relationships": [
//     {
//       "entity1": "string",
//       "relationship": "string",
//       "entity2": "string"
//     }
//   ],
//   "topics": ["string"],
//   "datesMentioned": ["string"],
//   "numericalData": [
//     {
//       "value": "string",
//       "context": "string"
//     }
//   ],
//   "classification": {
//     "documentType": "string",
//     "categories": ["string"]
//   },
//   "metadata": {
//     "author": "string",
//     "creationDate": "string",
//     "confidentialityLevel": "string"
//   }
// }
// Guidelines:

// Ensure all extracted information is directly supported by the document content.
// Use specific and concise descriptions.
// If a field is not applicable, use null or an empty array [].
// Focus on the most important and relevant information for knowledge graph construction.

// Example (truncated):
// {
//   "summary": "Q3 sales projections for Acme Corp's widget line, including market analysis and strategic recommendations.",
//   "entities": {
//     "people": ["Jane Doe", "John Smith"],
//     "organizations": ["Acme Corp", "WidgetRival Inc."],
//     "locations": ["North America", "Europe", "Asia"],
//     "keyTerms": ["Widget Pro", "Widget Lite", "Sales Forecasting"]
//   },
//   "relationships": [
//     {
//       "entity1": "Jane Doe",
//       "relationship": "Head of",
//       "entity2": "Sales Department"
//     },
//     {
//       "entity1": "Widget Pro",
//       "relationship": "product of",
//       "entity2": "Acme Corp"
//     }
//   ],
//   "topics": ["Sales Projections", "Market Analysis", "Strategic Planning"],
//   "datesMentioned": ["Q3 2024", "September 15, 2024"],
//   "numericalData": [
//     {
//       "value": "15%",
//       "context": "Expected YoY growth in Q3 widget sales"
//     },
//     {
//       "value": "$10M",
//       "context": "Projected revenue"
//     }
//   ],
//   "classification": {
//     "documentType": "Business Report",
//     "categories": ["Sales", "Strategic Planning"]
//   },
//   "metadata": {
//     "author": "Jane Doe",
//     "creationDate": "2024-06-01",
//     "confidentialityLevel": "Internal Use Only"
//   }
// }
// Analyze the given document and provide a comprehensive JSON output following this structure and example.
// `
export const kg1 = `You are an advanced algorithm designed to extract structured information from text to construct knowledge graphs. Your goal is to capture comprehensive information while maintaining accuracy. Analyze the given document and provide a JSON output with key information for knowledge graph construction.
Input Document:
{input_document}
Guidelines:

Extract only explicitly stated information from the input document above.
Identify nodes (entities/concepts), their types, and relationships.
Use "USER_ID" as the source node for any self-references (I, me, my, etc.) in user messages.
Use basic, general types for node labels (e.g., "person" instead of "mathematician").
Use consistent, general, and timeless relationship types (e.g., prefer "PROFESSOR" over "BECAME_PROFESSOR").
Use the most complete identifier for entities mentioned multiple times (e.g., always use "John Doe" instead of variations like "Joe" or pronouns).
Strive for a coherent, easily understandable knowledge graph by maintaining consistency in entity references and relationship types.

Use this JSON structure for your output:
{
  "summary": "string",
  "entities": [
    {
      "id": "string",
      "type": "string",
      "mentions": ["string"]
    }
  ],
  "relationships": [
    {
      "source": "string",
      "relationship": "string",
      "target": "string"
    }
  ],
  "topics": ["string"],
  "metadata": {
    "documentType": "string",
    "creationDate": "string",
    "confidentialityLevel": "string"
  }
}
Example output (truncated):
{
  "summary": "Q3 sales projections for Acme Corp's widget line, including market analysis and strategic recommendations.",
  "entities": [
    {
      "id": "Acme Corp",
      "type": "organization",
      "mentions": ["Acme Corp", "the company"]
    },
    {
      "id": "Jane Doe",
      "type": "person",
      "mentions": ["Jane Doe", "the head of sales"]
    }
  ],
  "relationships": [
    {
      "source": "Jane Doe",
      "relationship": "HEAD_OF",
      "target": "Sales Department"
    },
    {
      "source": "Widget Pro",
      "relationship": "PRODUCT_OF",
      "target": "Acme Corp"
    }
  ],
  "topics": ["Sales Projections", "Market Analysis", "Strategic Planning"],
  "metadata": {
    "documentType": "Business Report",
    "creationDate": "2024-06-01",
    "confidentialityLevel": "Internal Use Only"
  }
}
Analyze the input document provided above and generate a comprehensive JSON output following this structure and guidelines.`

export const kg2 = `You are an advanced algorithm designed to extract structured information from text to construct knowledge graphs. Your goal is to capture comprehensive information while maintaining accuracy. Analyze the given document and provide only a JSON output with key information for knowledge graph construction.
Input Document:
{input_document}
Guidelines:

Extract only explicitly stated information from the input document above.
Identify nodes (entities/concepts), their types, and relationships.
Use "USER_ID" as the source node for any self-references (I, me, my, etc.) in user messages.
Use basic, general types for node labels (e.g., "person" instead of "mathematician").
Use consistent, general, and timeless relationship types (e.g., prefer "PROFESSOR" over "BECAME_PROFESSOR").
Use the most complete identifier for entities mentioned multiple times (e.g., always use "John Doe" instead of variations like "Joe" or pronouns).
Strive for a coherent, easily understandable knowledge graph by maintaining consistency in entity references and relationship types.

Return the output strictly as JSON with no additional text or explanations.
Use this JSON structure for your output:
{
  "summary": "string",
  "entities": [
    {
      "id": "string",
      "type": "string",
      "mentions": ["string"]
    }
  ],
  "relationships": [
    {
      "source": "string",
      "relationship": "string",
      "target": "string"
    }
  ],
  "topics": ["string"],
  "metadata": {
    "documentType": "string",
    "creationDate": "string",
    "confidentialityLevel": "string"
  }
}
Analyze the input document provided above and generate a comprehensive JSON output following this structure and guidelines. The response must be strictly in JSON format.`


const kg3 = `"Take the following Google Doc text input and extract key entities and their relationships for a knowledge graph. Identify named entities such as people, organizations, dates, locations, and products. Return the output strictly in JSON format, including entity types and relationships. Below is the input text."

{input_document}
Expected JSON Output:

{
  "entities": [
    {
      "name": "Entity1",
      "type": "EntityType"
    },
    {
      "name": "Entity2",
      "type": "EntityType"
    }
    // ...more entities
  ],
  "relationships": [
    {
      "source": "Entity1",
      "relation": "RelationType",
      "target": "Entity2"
    },
    {
      "source": "Entity1",
      "relation": "RelationType",
      "target": "Entity3"
    }
    // ...more relationships
  ]
}
Example Input:

Google was founded by Larry Page and Sergey Brin in 1998. The headquarters is located in Mountain View, California. Google’s products include Search, Gmail, and Google Cloud.
Example JSON Output:

{
  "entities": [
    {
      "name": "Google",
      "type": "Organization"
    },
    {
      "name": "Larry Page",
      "type": "Person"
    },
    {
      "name": "Sergey Brin",
      "type": "Person"
    },
    {
      "name": "1998",
      "type": "Date"
    },
    {
      "name": "Mountain View, California",
      "type": "Location"
    },
    {
      "name": "Search",
      "type": "Product"
    },
    {
      "name": "Gmail",
      "type": "Product"
    },
    {
      "name": "Google Cloud",
      "type": "Product"
    }
  ],
  "relationships": [
    {
      "source": "Google",
      "relation": "founded_by",
      "target": "Larry Page"
    },
    {
      "source": "Google",
      "relation": "founded_by",
      "target": "Sergey Brin"
    },
    {
      "source": "Google",
      "relation": "founded_in",
      "target": "1998"
    },
    {
      "source": "Google",
      "relation": "headquartered_in",
      "target": "Mountain View, California"
    },
    {
      "source": "Google",
      "relation": "offers",
      "target": "Search"
    },
    {
      "source": "Google",
      "relation": "offers",
      "target": "Gmail"
    },
    {
      "source": "Google",
      "relation": "offers",
      "target": "Google Cloud"
    }
  ]
}`

export const getPrompt = (document: string) => {
    return kg3.replace('{input_document}', document)
}
