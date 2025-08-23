import type {
  VespaEntityDocument,
  VespaRelationshipDocument,
} from "./vespa-builder"

export interface KnowledgeGraphQuery {
  findEntity(name: string, type?: string): Promise<VespaEntityDocument | null>
  findEntitiesByType(type: string): Promise<VespaEntityDocument[]>
  findRelationships(entityName: string): Promise<VespaRelationshipDocument[]>
  traverseGraph(
    startEntity: string,
    maxDepth?: number,
  ): Promise<GraphTraversalResult>
  searchEntities(query: string): Promise<VespaEntityDocument[]>
}

export interface GraphTraversalResult {
  entities: VespaEntityDocument[]
  relationships: VespaRelationshipDocument[]
  paths: GraphPath[]
}

export interface GraphPath {
  entities: string[]
  relationships: string[]
  depth: number
}

export class VespaKnowledgeGraphQuerier implements KnowledgeGraphQuery {
  constructor(private vespaClient: any) {}

  async findEntity(
    name: string,
    type?: string,
  ): Promise<VespaEntityDocument | null> {
    const typeFilter = type ? ` and entityType contains "${type}"` : ""
    const yql = `select * from kg_entity where entityName contains "${name}"${typeFilter}`

    const response = await this.vespaClient.search({
      yql,
      hits: 1,
    })

    return response.root?.children?.[0]?.fields || null
  }

  async findEntitiesByType(type: string): Promise<VespaEntityDocument[]> {
    const yql = `select * from kg_entity where entityType contains "${type}"`

    const response = await this.vespaClient.search({
      yql,
      hits: 100,
    })

    return response.root?.children?.map((hit: any) => hit.fields) || []
  }

  async findRelationships(
    entityName: string,
  ): Promise<VespaRelationshipDocument[]> {
    const yql = `select * from kg_relationship where sourceEntityName contains "${entityName}" or targetEntityName contains "${entityName}"`

    const response = await this.vespaClient.search({
      yql,
      hits: 100,
    })

    return response.root?.children?.map((hit: any) => hit.fields) || []
  }

  async traverseGraph(
    startEntity: string,
    maxDepth: number = 3,
  ): Promise<GraphTraversalResult> {
    const visitedEntities = new Set<string>()
    const allEntities: VespaEntityDocument[] = []
    const allRelationships: VespaRelationshipDocument[] = []
    const paths: GraphPath[] = []

    // Start with the initial entity
    const startEntityDoc = await this.findEntity(startEntity)
    if (!startEntityDoc) {
      return { entities: [], relationships: [], paths: [] }
    }

    allEntities.push(startEntityDoc)
    visitedEntities.add(startEntity)

    // BFS traversal
    const queue: Array<{ entity: string; depth: number; path: string[] }> = [
      { entity: startEntity, depth: 0, path: [startEntity] },
    ]

    while (queue.length > 0) {
      const { entity, depth, path } = queue.shift()!

      if (depth >= maxDepth) continue

      // Find all relationships for this entity
      const relationships = await this.findRelationships(entity)

      for (const rel of relationships) {
        allRelationships.push(rel)

        // Find the connected entity
        const connectedEntity =
          rel.sourceEntityName === entity ? rel.targetEntityName : rel.sourceEntityName

        if (!visitedEntities.has(connectedEntity)) {
          visitedEntities.add(connectedEntity)

          // Find the entity document
          const entityDoc = await this.findEntity(connectedEntity)
          if (entityDoc) {
            allEntities.push(entityDoc)

            // Add to queue for further traversal
            const newPath = [...path, connectedEntity]
            queue.push({
              entity: connectedEntity,
              depth: depth + 1,
              path: newPath,
            })

            // Record the path
            paths.push({
              entities: newPath,
              relationships: [
                ...path
                  .slice(0, -1)
                  .map((_, i) => `${path[i]}_to_${path[i + 1]}`),
              ],
              depth: depth + 1,
            })
          }
        }
      }
    }

    return {
      entities: allEntities,
      relationships: allRelationships,
      paths,
    }
  }

  async searchEntities(query: string): Promise<VespaEntityDocument[]> {
    const yql = `select * from kg_entity where entityName contains "${query}" or description contains "${query}"`

    const response = await this.vespaClient.search({
      yql,
      hits: 50,
    })

    return response.root?.children?.map((hit: any) => hit.fields) || []
  }

  async getAllRelationships(limit: number = 200): Promise<VespaRelationshipDocument[]> {
    const yql = `select * from kg_relationship where true`

    const response = await this.vespaClient.search({
      yql,
      hits: limit,
    })

    return response.root?.children?.map((hit: any) => hit.fields) || []
  }

  // Advanced query: Find entities with specific relationship patterns
  async findEntitiesWithRelation(
    relationshipType: string,
    targetEntity?: string,
  ): Promise<VespaEntityDocument[]> {
    let yql = `select * from kg_relationship where relationshipType contains "${relationshipType}"`

    if (targetEntity) {
      yql += ` and targetEntityName contains "${targetEntity}"`
    }

    const relationshipResponse = await this.vespaClient.search({
      yql,
      hits: 100,
    })

    const relationships =
      relationshipResponse.root?.children?.map((hit: any) => hit.fields) || []

    // Get unique source entities
    const sourceEntities = [
      ...new Set(
        relationships.map(
          (rel: VespaRelationshipDocument) => rel.sourceEntityName,
        ),
      ),
    ]

    // Fetch entity documents
    const entities: VespaEntityDocument[] = []
    for (const entityName of sourceEntities) {
      if (typeof entityName === "string") {
        const entity = await this.findEntity(entityName)
        if (entity) {
          entities.push(entity)
        }
      }
    }

    return entities
  }

  // Query for relationship analytics
  async getRelationshipStats(): Promise<{
    totalEntities: number
    totalRelationships: number
    relationshipTypes: Record<string, number>
    entityTypes: Record<string, number>
  }> {
    // Count entities
    const entityCountResponse = await this.vespaClient.search({
      yql: "select * from kg_entity where true limit 0",
      hits: 0,
    })

    // Count relationships
    const relationshipCountResponse = await this.vespaClient.search({
      yql: "select * from kg_relationship where true limit 0",
      hits: 0,
    })

    // Get all relationships for type analysis (respecting Vespa limit)
    const allRelationships = await this.vespaClient.search({
      yql: "select relationshipType from kg_relationship where true",
      hits: 400,
    })

    // Get all entities for type analysis (respecting Vespa limit)
    const allEntities = await this.vespaClient.search({
      yql: "select entityType from kg_entity where true",
      hits: 400,
    })

    // Aggregate relationship types
    const relationshipTypes: Record<string, number> = {}
    for (const hit of allRelationships.root?.children || []) {
      const type = hit.fields.relationshipType
      relationshipTypes[type] = (relationshipTypes[type] || 0) + 1
    }

    // Aggregate entity types
    const entityTypes: Record<string, number> = {}
    for (const hit of allEntities.root?.children || []) {
      const type = hit.fields.entityType
      entityTypes[type] = (entityTypes[type] || 0) + 1
    }

    return {
      totalEntities: entityCountResponse.root?.fields?.totalCount || 0,
      totalRelationships:
        relationshipCountResponse.root?.fields?.totalCount || 0,
      relationshipTypes,
      entityTypes,
    }
  }
}
