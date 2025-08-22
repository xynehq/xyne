import { KnowledgeGraphExtractor } from "./extractor"
import { VespaKnowledgeGraphBuilder } from "./vespa-builder"
import { VespaKnowledgeGraphQuerier } from "./querier"

export interface KnowledgeGraphPipeline {
  processDocument(documentId: string, content: string): Promise<void>
  processMultipleDocuments(
    documents: Array<{ id: string; content: string }>,
  ): Promise<void>
  queryGraph(): VespaKnowledgeGraphQuerier
}

export class KnowledgeGraphService implements KnowledgeGraphPipeline {
  private extractor: KnowledgeGraphExtractor
  private builder: VespaKnowledgeGraphBuilder
  private querier: VespaKnowledgeGraphQuerier

  constructor(
    private llmClient: any,
    private vespaClient: any,
  ) {
    this.extractor = new KnowledgeGraphExtractor(llmClient)
    this.builder = new VespaKnowledgeGraphBuilder()
    this.querier = new VespaKnowledgeGraphQuerier(vespaClient)
  }

  async processDocument(documentId: string, content: string): Promise<void> {
    try {
      console.log(
        `Processing document ${documentId} for knowledge graph extraction...`,
      )

      // Extract entities and relationships
      const extractionResult = await this.extractor.extractFromText(
        content,
        documentId,
      )

      console.log(
        `Extracted ${extractionResult.entities.length} entities and ${extractionResult.relationships.length} relationships`,
      )

      // Build Vespa documents
      const documents = this.builder.buildDocuments(
        extractionResult.entities,
        extractionResult.relationships,
      )

      // Convert to Vespa feed format
      const feed = this.builder.toVespaFeed(documents)

      // Send to Vespa
      await this.sendToVespa(feed)

      console.log(
        `Successfully stored knowledge graph data for document ${documentId}`,
      )
    } catch (error) {
      console.error(`Failed to process document ${documentId}:`, error)
      throw error
    }
  }

  async processMultipleDocuments(
    documents: Array<{ id: string; content: string }>,
  ): Promise<void> {
    try {
      console.log(
        `Processing ${documents.length} documents for knowledge graph extraction...`,
      )

      // Extract from all documents
      const extractionResult =
        await this.extractor.extractFromDocuments(documents)

      console.log(
        `Total extracted: ${extractionResult.entities.length} entities and ${extractionResult.relationships.length} relationships`,
      )

      // Build Vespa documents
      const vespaDocuments = this.builder.buildDocuments(
        extractionResult.entities,
        extractionResult.relationships,
      )

      // Convert to Vespa feed format
      const feed = this.builder.toVespaFeed(vespaDocuments)

      // Send to Vespa in batches
      await this.sendToVespaBatched(feed, 100)

      console.log(
        `Successfully stored knowledge graph data for ${documents.length} documents`,
      )
    } catch (error) {
      console.error(`Failed to process multiple documents:`, error)
      throw error
    }
  }

  queryGraph(): VespaKnowledgeGraphQuerier {
    return this.querier
  }

  private async sendToVespa(feed: any[]): Promise<void> {
    if (feed.length === 0) return

    try {
      const response = await this.vespaClient.feed(feed)

      if (response.errors && response.errors.length > 0) {
        console.warn("Some documents failed to index:", response.errors)
      }
    } catch (error) {
      console.error("Failed to send data to Vespa:", error)
      throw error
    }
  }

  private async sendToVespaBatched(
    feed: any[],
    batchSize: number,
  ): Promise<void> {
    for (let i = 0; i < feed.length; i += batchSize) {
      const batch = feed.slice(i, i + batchSize)
      console.log(
        `Sending batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(feed.length / batchSize)}`,
      )
      await this.sendToVespa(batch)

      // Small delay between batches to avoid overwhelming Vespa
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // Utility methods for common operations
  async getKnowledgeGraphStats() {
    return await this.querier.getRelationshipStats()
  }

  async findConnectedEntities(entityName: string, maxDepth: number = 2) {
    return await this.querier.traverseGraph(entityName, maxDepth)
  }

  async searchKnowledgeGraph(query: string) {
    return await this.querier.searchEntities(query)
  }

  async findEntitiesByRelation(
    relationshipType: string,
    targetEntity?: string,
  ) {
    return await this.querier.findEntitiesWithRelation(
      relationshipType,
      targetEntity,
    )
  }
}

// Helper function to create a knowledge graph service instance
export function createKnowledgeGraphService(
  llmClient: any,
  vespaClient: any,
): KnowledgeGraphService {
  return new KnowledgeGraphService(llmClient, vespaClient)
}

// Example usage patterns
export const KnowledgeGraphExamples = {
  // Process a single document
  async processSingleDocument(
    service: KnowledgeGraphService,
    docId: string,
    content: string,
  ) {
    await service.processDocument(docId, content)
  },

  // Process multiple documents
  async processDocumentBatch(
    service: KnowledgeGraphService,
    documents: Array<{ id: string; content: string }>,
  ) {
    await service.processMultipleDocuments(documents)
  },

  // Find all people mentioned in documents
  async findAllPeople(service: KnowledgeGraphService) {
    return await service.queryGraph().findEntitiesByType("PERSON")
  },

  // Find all organizations a person is connected to
  async findPersonOrganizations(
    service: KnowledgeGraphService,
    personName: string,
  ) {
    return await service
      .queryGraph()
      .findEntitiesWithRelation("works_at", undefined)
  },

  // Traverse the knowledge graph from a starting entity
  async exploreFromEntity(service: KnowledgeGraphService, entityName: string) {
    return await service.findConnectedEntities(entityName, 3)
  },

  // Get knowledge graph statistics
  async getStats(service: KnowledgeGraphService) {
    return await service.getKnowledgeGraphStats()
  },
}
