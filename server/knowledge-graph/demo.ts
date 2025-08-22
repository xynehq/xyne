#!/usr/bin/env bun
/**
 * Knowledge Graph Demo Script
 *
 * This script demonstrates how to use the knowledge graph system
 * to extract entities and relationships from documents and query them.
 */

import { createKnowledgeGraphService, KnowledgeGraphExamples } from "./pipeline"
import sampleData from "./sample-data.json"

// Mock LLM client for demonstration
class MockLLMClient {
  async complete({
    messages,
  }: { messages: Array<{ role: string; content: string }> }) {
    // In a real implementation, this would call your actual LLM
    console.log(
      "🤖 LLM processing:",
      messages[0].content.substring(0, 100) + "...",
    )

    // Return the sample extraction result
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: sampleData.knowledge_graph_example.extracted_entities,
              relationships:
                sampleData.knowledge_graph_example.extracted_relationships,
            }),
          },
        },
      ],
    }
  }
}

// Mock Vespa client for demonstration
class MockVespaClient {
  private entities: any[] = []
  private relationships: any[] = []

  async feed(documents: any[]) {
    console.log(`📊 Storing ${documents.length} documents in Vespa`)

    for (const doc of documents) {
      if (doc.put.includes("kg_entity")) {
        this.entities.push(doc.fields)
      } else if (doc.put.includes("kg_relationship")) {
        this.relationships.push(doc.fields)
      }
    }

    return { errors: [] }
  }

  async search({ yql, hits = 10 }: { yql: string; hits?: number }) {
    console.log(`🔍 Vespa query: ${yql}`)

    let results: any[] = []

    if (yql.includes("kg_entity")) {
      results = this.entities.slice(0, hits)
    } else if (yql.includes("kg_relationship")) {
      results = this.relationships.slice(0, hits)
    }

    return {
      root: {
        fields: { totalCount: results.length },
        children: results.map((fields) => ({ fields })),
      },
    }
  }
}

async function runDemo() {
  console.log("🚀 Starting Knowledge Graph Demo\n")

  // Initialize the knowledge graph service
  const llmClient = new MockLLMClient()
  const vespaClient = new MockVespaClient()
  const kgService = createKnowledgeGraphService(llmClient, vespaClient)

  try {
    // Demo 1: Process a single document
    console.log("📄 Demo 1: Processing a single document")
    console.log("=".repeat(50))

    const sampleDoc = sampleData.knowledge_graph_example.sample_documents[0]
    await KnowledgeGraphExamples.processSingleDocument(
      kgService,
      sampleDoc.id,
      sampleDoc.content,
    )
    console.log("✅ Document processed successfully\n")

    // Demo 2: Process multiple documents
    console.log("📚 Demo 2: Processing multiple documents")
    console.log("=".repeat(50))

    await KnowledgeGraphExamples.processDocumentBatch(
      kgService,
      sampleData.knowledge_graph_example.sample_documents,
    )
    console.log("✅ Batch processing completed\n")

    // Demo 3: Find all people
    console.log("👥 Demo 3: Finding all people entities")
    console.log("=".repeat(50))

    const people = await KnowledgeGraphExamples.findAllPeople(kgService)
    console.log(`Found ${people.length} people:`)
    people.forEach((person) => {
      console.log(`  - ${person.name} (${person.type}): ${person.description}`)
    })
    console.log()

    // Demo 4: Knowledge graph traversal
    console.log("🕸️  Demo 4: Knowledge graph traversal from 'TechCorp'")
    console.log("=".repeat(50))

    const traversalResult = await KnowledgeGraphExamples.exploreFromEntity(
      kgService,
      "TechCorp",
    )
    console.log(`Found ${traversalResult.entities.length} connected entities:`)
    traversalResult.entities.forEach((entity) => {
      console.log(`  - ${entity.name} (${entity.type})`)
    })

    console.log(
      `\nFound ${traversalResult.relationships.length} relationships:`,
    )
    traversalResult.relationships.forEach((rel) => {
      console.log(
        `  - ${rel.source_entity} --[${rel.relationship_type}]--> ${rel.target_entity}`,
      )
    })
    console.log()

    // Demo 5: Knowledge graph statistics
    console.log("📊 Demo 5: Knowledge graph statistics")
    console.log("=".repeat(50))

    const stats = await KnowledgeGraphExamples.getStats(kgService)
    console.log("Knowledge Graph Statistics:")
    console.log(`  Total Entities: ${stats.totalEntities}`)
    console.log(`  Total Relationships: ${stats.totalRelationships}`)

    console.log("\n  Entity Types:")
    Object.entries(stats.entityTypes).forEach(([type, count]) => {
      console.log(`    ${type}: ${count}`)
    })

    console.log("\n  Relationship Types:")
    Object.entries(stats.relationshipTypes).forEach(([type, count]) => {
      console.log(`    ${type}: ${count}`)
    })
    console.log()

    // Demo 6: Sample queries from the JSON
    console.log("🔍 Demo 6: Sample knowledge graph queries")
    console.log("=".repeat(50))

    const queries = sampleData.knowledge_graph_example.sample_queries

    for (const [queryName, queryInfo] of Object.entries(queries)) {
      console.log(`\nQuery: ${queryInfo.description}`)
      console.log(`YQL: ${queryInfo.vespa_yql}`)
      console.log("Expected results:")
      queryInfo.expected_results.forEach((result: string) => {
        console.log(`  - ${result}`)
      })
    }

    console.log("\n🎉 Demo completed successfully!")
  } catch (error) {
    console.error("❌ Demo failed:", error)
  }
}

// Additional utility functions for testing
export async function testKnowledgeGraphExtraction() {
  console.log("🧪 Testing Knowledge Graph Extraction\n")

  const testDocument = {
    id: "test_doc",
    content:
      "Apple Inc. was founded by Steve Jobs and Steve Wozniak in Cupertino, California. The company develops the iPhone and MacBook products. Tim Cook is the current CEO.",
  }

  const llmClient = new MockLLMClient()
  const vespaClient = new MockVespaClient()
  const kgService = createKnowledgeGraphService(llmClient, vespaClient)

  await kgService.processDocument(testDocument.id, testDocument.content)

  // Test various queries
  const querier = kgService.queryGraph()

  // Find entities by type
  const companies = await querier.findEntitiesByType("ORGANIZATION")
  console.log(
    "Companies found:",
    companies.map((c) => c.name),
  )

  // Find relationships
  const relationships = await querier.findRelationships("Apple Inc.")
  console.log(
    "Apple relationships:",
    relationships.map((r) => `${r.source_entity} -> ${r.target_entity}`),
  )

  // Search entities
  const searchResults = await querier.searchEntities("Steve")
  console.log(
    "Search results for 'Steve':",
    searchResults.map((e) => e.name),
  )
}

// Example integration with existing document processing pipeline
export function integrateWithExistingPipeline() {
  console.log("🔌 Integration Example\n")

  const integrationCode = `
// Example: Integrate with your existing document processing
import { createKnowledgeGraphService } from './knowledge-graph/pipeline';

async function processDocumentWithKnowledgeGraph(document: Document) {
  // Your existing document processing
  const processedDoc = await existingDocumentProcessor(document);
  
  // Add knowledge graph extraction
  const kgService = createKnowledgeGraphService(llmClient, vespaClient);
  await kgService.processDocument(document.id, document.content);
  
  // Query the knowledge graph
  const entities = await kgService.queryGraph().findEntitiesByType("PERSON");
  const relationships = await kgService.queryGraph().findRelationships(entities[0]?.name || "");
  
  return {
    ...processedDoc,
    knowledgeGraph: {
      entities,
      relationships
    }
  };
}

// Example: Query across multiple documents
async function findEntityConnections(entityName: string) {
  const kgService = createKnowledgeGraphService(llmClient, vespaClient);
  const connections = await kgService.findConnectedEntities(entityName, 3);
  
  return connections;
}
  `

  console.log(integrationCode)
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  runDemo().catch(console.error)
}
