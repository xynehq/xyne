/**
 * Knowledge Graph System for Vespa
 *
 * A complete knowledge graph implementation that extracts entities and relationships
 * from documents and stores them in Vespa for searchable graph traversal.
 *
 * Inspired by LightRAG, this system provides:
 * - LLM-based entity and relationship extraction
 * - Vespa-native storage (no separate graph database needed)
 * - Graph traversal through Vespa queries
 * - Relationship analytics and visualization
 */

// Core components
export { KnowledgeGraphExtractor } from "./extractor"
export { VespaKnowledgeGraphBuilder } from "./vespa-builder"
export { VespaKnowledgeGraphQuerier } from "./querier"
export {
  KnowledgeGraphService,
  createKnowledgeGraphService,
  KnowledgeGraphExamples,
} from "./pipeline"

// Types
export type { Entity, Relationship, ExtractionResult } from "./extractor"
export type {
  VespaEntityDocument,
  VespaRelationshipDocument,
} from "./vespa-builder"
export type {
  KnowledgeGraphQuery,
  GraphTraversalResult,
  GraphPath,
} from "./querier"
export type { KnowledgeGraphPipeline } from "./pipeline"

// Demo and testing utilities
export {
  testKnowledgeGraphExtraction,
  integrateWithExistingPipeline,
} from "./demo"

/**
 * Quick Start Guide:
 *
 * 1. Install dependencies and set up Vespa schemas:
 *    - The schemas kg_entity.sd and kg_relationship.sd are already in vespa/schemas/
 *
 * 2. Create a knowledge graph service:
 *    ```typescript
 *    import { createKnowledgeGraphService } from './knowledge-graph';
 *
 *    const kgService = createKnowledgeGraphService(llmClient, vespaClient);
 *    ```
 *
 * 3. Process documents:
 *    ```typescript
 *    await kgService.processDocument(documentId, documentContent);
 *    ```
 *
 * 4. Query the knowledge graph:
 *    ```typescript
 *    const querier = kgService.queryGraph();
 *    const entities = await querier.findEntitiesByType("PERSON");
 *    const connections = await querier.traverseGraph("TechCorp", 3);
 *    ```
 *
 * 5. Run the demo:
 *    ```bash
 *    bun run server/knowledge-graph/demo.ts
 *    ```
 */

// Configuration constants
export const KNOWLEDGE_GRAPH_CONFIG = {
  DEFAULT_MAX_DEPTH: 3,
  DEFAULT_CONFIDENCE_THRESHOLD: 0.7,
  BATCH_SIZE: 100,
  ENTITY_TYPES: [
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "CONCEPT",
    "PRODUCT",
    "EVENT",
    "DATE",
  ] as const,
  COMMON_RELATIONSHIP_TYPES: [
    "works_at",
    "employed_by",
    "located_in",
    "based_in",
    "develops",
    "creates",
    "maintains",
    "collaborates_with",
    "partners_with",
    "mentions",
    "discusses",
    "references",
    "acquired",
    "founded",
    "invested_in",
    "manages",
    "reports_to",
  ] as const,
}

/**
 * Example Usage Patterns:
 */
export const USAGE_EXAMPLES = {
  // Basic document processing
  processDocument: `
const kgService = createKnowledgeGraphService(llmClient, vespaClient);
await kgService.processDocument("doc_001", documentContent);
  `,

  // Batch processing
  processBatch: `
const documents = [
  { id: "doc_001", content: "..." },
  { id: "doc_002", content: "..." }
];
await kgService.processMultipleDocuments(documents);
  `,

  // Find entity connections
  findConnections: `
const connections = await kgService.findConnectedEntities("Apple Inc.", 2);
console.log(connections.entities.map(e => e.name));
  `,

  // Search entities
  searchEntities: `
const results = await kgService.searchKnowledgeGraph("machine learning");
console.log(results.map(e => \`\${e.name} (\${e.type})\`));
  `,

  // Relationship analysis
  analyzeRelationships: `
const stats = await kgService.getKnowledgeGraphStats();
console.log("Entity types:", stats.entityTypes);
console.log("Relationship types:", stats.relationshipTypes);
  `,

  // Complex queries
  complexQuery: `
const querier = kgService.queryGraph();

// Find all people who work at tech companies
const techWorkers = await querier.findEntitiesWithRelation("works_at");

// Find companies that acquired other companies  
const acquisitions = await querier.findEntitiesWithRelation("acquired");

// Traverse from a person to find their network
const network = await querier.traverseGraph("John Smith", 3);
  `,
}
