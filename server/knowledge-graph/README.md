# Knowledge Graph System for Vespa

A complete knowledge graph implementation that extracts entities and relationships from documents using LLMs and stores them in Vespa for searchable graph traversal. Inspired by LightRAG, this system provides enterprise-grade knowledge graph capabilities without requiring a separate graph database.

## 🎯 Core Features

- **LLM-Based Extraction**: Automatically extract entities and relationships from unstructured text
- **Vespa-Native Storage**: Store knowledge graph data directly in your existing Vespa cluster
- **Graph Traversal**: Query relationships and navigate the knowledge graph using Vespa's search capabilities
- **Multi-Document Processing**: Build knowledge graphs across multiple data sources
- **Relationship Analytics**: Analyze entity connections and relationship patterns
- **Scalable Architecture**: Leverage Vespa's distributed architecture for large-scale knowledge graphs

## 🏗️ Architecture

```
Documents → LLM Analysis → Extract Entities & Relationships → Store in Vespa → Query/Visualize
```

### Components

1. **KnowledgeGraphExtractor**: Uses LLMs to extract entities and relationships from text
2. **VespaKnowledgeGraphBuilder**: Converts extracted data into Vespa document format
3. **VespaKnowledgeGraphQuerier**: Provides graph traversal and search capabilities
4. **KnowledgeGraphService**: Main pipeline that orchestrates the entire process

## 📊 Data Model

### Entities (kg_entity schema)
- **name**: Entity name (e.g., "John Smith", "Apple Inc.")
- **type**: Entity type (PERSON, ORGANIZATION, LOCATION, etc.)
- **description**: Natural language description
- **properties**: Additional metadata and attributes
- **embeddings**: Vector embeddings for semantic search

### Relationships (kg_relationship schema)
- **source_entity**: Source entity name
- **target_entity**: Target entity name
- **relationship_type**: Type of relationship (works_at, acquired, etc.)
- **description**: Natural language description of the relationship
- **confidence**: Extraction confidence score (0-1)
- **properties**: Additional relationship metadata

## 🚀 Quick Start

### 1. Prerequisites

Ensure you have the Vespa schemas deployed:
- `kg_entity.sd` - Entity storage schema
- `kg_relationship.sd` - Relationship storage schema

These schemas are already included in `server/vespa/schemas/`.

### 2. Basic Usage

```typescript
import { createKnowledgeGraphService } from './knowledge-graph';

// Initialize the service
const kgService = createKnowledgeGraphService(llmClient, vespaClient);

// Process a single document
await kgService.processDocument("doc_001", documentContent);

// Process multiple documents
const documents = [
  { id: "doc_001", content: "Apple Inc. was founded by Steve Jobs..." },
  { id: "doc_002", content: "Microsoft Corporation develops software..." }
];
await kgService.processMultipleDocuments(documents);

// Query the knowledge graph
const querier = kgService.queryGraph();

// Find all people
const people = await querier.findEntitiesByType("PERSON");

// Find entity connections
const connections = await querier.traverseGraph("Apple Inc.", 3);

// Search entities
const results = await querier.searchEntities("machine learning");
```

### 3. Run the Demo

```bash
bun run server/knowledge-graph/demo.ts
```

## 📖 Detailed Examples

### Entity and Relationship Extraction

The system automatically extracts structured data from unstructured text:

**Input Document:**
```
"John Smith, CEO of TechCorp, announced the acquisition of DataSystems Inc. 
The deal was finalized in San Francisco with legal advisor Maria Rodriguez."
```

**Extracted Entities:**
- John Smith (PERSON) - CEO of TechCorp
- TechCorp (ORGANIZATION) - Technology company
- DataSystems Inc (ORGANIZATION) - Acquired company
- San Francisco (LOCATION) - Deal location
- Maria Rodriguez (PERSON) - Legal advisor

**Extracted Relationships:**
- John Smith --[CEO_OF]--> TechCorp
- TechCorp --[ACQUIRED]--> DataSystems Inc
- Maria Rodriguez --[ADVISED]--> TechCorp

### Graph Traversal

```typescript
// Find all entities connected to TechCorp within 2 degrees
const traversal = await querier.traverseGraph("TechCorp", 2);

console.log("Connected entities:");
traversal.entities.forEach(entity => {
  console.log(`- ${entity.name} (${entity.type})`);
});

console.log("Relationship paths:");
traversal.paths.forEach(path => {
  console.log(`Path: ${path.entities.join(" -> ")}`);
});
```

### Advanced Queries

```typescript
// Find all people who work at organizations
const employees = await querier.findEntitiesWithRelation("works_at");

// Find acquisition relationships
const acquisitions = await querier.findEntitiesWithRelation("acquired");

// Get knowledge graph statistics
const stats = await kgService.getKnowledgeGraphStats();
console.log(`Total entities: ${stats.totalEntities}`);
console.log(`Entity types:`, stats.entityTypes);
console.log(`Relationship types:`, stats.relationshipTypes);
```

## 🔍 Sample Queries

### Vespa YQL Examples

```sql
-- Find all entities of a specific type
SELECT * FROM kg_entity WHERE type CONTAINS "PERSON"

-- Find all relationships involving a specific entity
SELECT * FROM kg_relationship 
WHERE sourceEntityName CONTAINS "TechCorp" 
   OR targetEntityName CONTAINS "TechCorp"

-- Find specific relationship types
SELECT * FROM kg_relationship 
WHERE relationshipType CONTAINS "works_at"

-- Search entities by description
SELECT * FROM kg_entity 
WHERE description CONTAINS "artificial intelligence"
```

## 📈 Analytics and Insights

The system provides built-in analytics for understanding your knowledge graph:

```typescript
const stats = await kgService.getKnowledgeGraphStats();

// Entity distribution
console.log("Entity Types:");
Object.entries(stats.entityTypes).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Relationship patterns
console.log("Relationship Types:");
Object.entries(stats.relationshipTypes).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Find most connected entities (high centrality)
const traversal = await querier.traverseGraph("TechCorp", 1);
console.log(`TechCorp has ${traversal.relationships.length} direct connections`);
```

## 🛠️ Configuration

### Entity Types
- **PERSON**: Individual people
- **ORGANIZATION**: Companies, institutions, groups
- **LOCATION**: Places, addresses, geographical locations
- **CONCEPT**: Ideas, technologies, methodologies
- **PRODUCT**: Products, services, software
- **EVENT**: Meetings, conferences, incidents
- **DATE**: Specific dates or time periods

### Common Relationship Types
- `works_at`, `employed_by` - Employment relationships
- `located_in`, `based_in` - Location relationships
- `develops`, `creates`, `maintains` - Creation relationships
- `collaborates_with`, `partners_with` - Partnership relationships
- `acquired`, `founded`, `invested_in` - Business relationships
- `mentions`, `discusses`, `references` - Reference relationships

## 🔧 Integration with Existing Pipeline

```typescript
// Example: Integrate with your existing document processing
import { createKnowledgeGraphService } from './knowledge-graph';

async function processDocumentWithKnowledgeGraph(document: Document) {
  // Your existing document processing
  const processedDoc = await existingDocumentProcessor(document);
  
  // Add knowledge graph extraction
  const kgService = createKnowledgeGraphService(llmClient, vespaClient);
  await kgService.processDocument(document.id, document.content);
  
  // Query the knowledge graph for additional insights
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
```

## 🎨 Visualization Ideas

The knowledge graph data can be visualized using various tools:

1. **Network Graphs**: Use D3.js or Cytoscape.js to visualize entity relationships
2. **Entity Cards**: Display entity information with connection counts
3. **Relationship Timeline**: Show how relationships evolve over time
4. **Centrality Analysis**: Highlight most important entities in the graph

## 🚦 Performance Considerations

- **Batch Processing**: Process multiple documents together for efficiency
- **Confidence Filtering**: Filter relationships by confidence score to reduce noise
- **Incremental Updates**: Update existing entities rather than creating duplicates
- **Query Optimization**: Use Vespa's ranking profiles for better query performance

## 📋 TODO / Future Enhancements

- [ ] Add support for temporal relationships (time-based connections)
- [ ] Implement entity disambiguation and merging
- [ ] Add support for hierarchical entity types
- [ ] Create visualization components for the frontend
- [ ] Add relationship strength scoring
- [ ] Implement graph algorithms (PageRank, community detection)
- [ ] Add support for multilingual entity extraction

## 🤝 Contributing

This knowledge graph system is designed to be extensible. Key areas for contribution:

1. **Extraction Prompts**: Improve LLM prompts for better entity/relationship extraction
2. **Schema Extensions**: Add new entity types or relationship properties
3. **Query Patterns**: Develop new graph traversal patterns
4. **Analytics**: Add new graph analysis capabilities
5. **Visualization**: Create frontend components for graph visualization

## 📚 References

- [LightRAG](https://github.com/HKUDS/LightRAG) - Inspiration for the knowledge graph approach
- [Vespa Documentation](https://docs.vespa.ai/) - Vespa search engine documentation
- [Knowledge Graph Best Practices](https://www.w3.org/TR/dwbp/) - W3C recommendations for knowledge graphs
