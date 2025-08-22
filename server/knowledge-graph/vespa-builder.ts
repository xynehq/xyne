import type { Entity, Relationship } from "./extractor"

export interface VespaEntityDocument {
  id: string
  name: string
  type: string
  description?: string
  properties: Record<string, any>
  embeddings?: number[]
  created_at: number
  updated_at: number
}

export interface VespaRelationshipDocument {
  id: string
  source_entity: string
  target_entity: string
  relationship_type: string
  description?: string
  confidence: number
  properties: Record<string, any>
  created_at: number
  updated_at: number
}

export class VespaKnowledgeGraphBuilder {
  private generateEntityId(entity: Entity): string {
    return `entity_${entity.name.toLowerCase().replace(/\s+/g, "_")}_${entity.type.toLowerCase()}`
  }

  private generateRelationshipId(relationship: Relationship): string {
    const source = relationship.source.toLowerCase().replace(/\s+/g, "_")
    const target = relationship.target.toLowerCase().replace(/\s+/g, "_")
    const type = relationship.type.toLowerCase().replace(/\s+/g, "_")
    return `rel_${source}_${type}_${target}`
  }

  buildEntityDocument(entity: Entity): VespaEntityDocument {
    const now = Date.now()

    return {
      id: this.generateEntityId(entity),
      name: entity.name,
      type: entity.type,
      description: entity.description,
      properties: entity.properties || {},
      created_at: now,
      updated_at: now,
    }
  }

  buildRelationshipDocument(
    relationship: Relationship,
  ): VespaRelationshipDocument {
    const now = Date.now()

    return {
      id: this.generateRelationshipId(relationship),
      source_entity: relationship.source,
      target_entity: relationship.target,
      relationship_type: relationship.type,
      description: relationship.description,
      confidence: relationship.confidence || 0.8,
      properties: relationship.properties || {},
      created_at: now,
      updated_at: now,
    }
  }

  buildDocuments(entities: Entity[], relationships: Relationship[]) {
    const entityDocs = entities.map((entity) =>
      this.buildEntityDocument(entity),
    )
    const relationshipDocs = relationships.map((rel) =>
      this.buildRelationshipDocument(rel),
    )

    return {
      entities: entityDocs,
      relationships: relationshipDocs,
    }
  }

  // Helper to convert to Vespa feed format
  toVespaFeed(documents: {
    entities: VespaEntityDocument[]
    relationships: VespaRelationshipDocument[]
  }) {
    const feed: any[] = []

    // Add entity documents
    for (const entity of documents.entities) {
      feed.push({
        put: `id:knowledge_graph:kg_entity::${entity.id}`,
        fields: entity,
      })
    }

    // Add relationship documents
    for (const relationship of documents.relationships) {
      feed.push({
        put: `id:knowledge_graph:kg_relationship::${relationship.id}`,
        fields: relationship,
      })
    }

    return feed
  }
}
