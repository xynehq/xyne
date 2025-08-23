import { Hono } from "hono"
import { VespaKnowledgeGraphQuerier } from "./querier"
import VespaClient from "@/search/vespaClient"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "knowledge-graph-api" })

// Initialize Vespa client and querier
const vespaClient = new VespaClient()
const kgQuerier = new VespaKnowledgeGraphQuerier(vespaClient)

const app = new Hono()

// Get entity by name
app.get('/entity/:name', async (c) => {
  try {
    const name = c.req.param('name')
    const type = c.req.query('type')
    
    Logger.info(`Finding entity: ${name}${type ? ` of type: ${type}` : ''}`)
    
    const entity = await kgQuerier.findEntity(name, type)
    
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404)
    }
    
    return c.json({ entity })
  } catch (error) {
    Logger.error('Error finding entity:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get entities by type
app.get('/entities/type/:type', async (c) => {
  try {
    const type = c.req.param('type')
    const limit = parseInt(c.req.query('limit') || '50')
    
    Logger.info(`Finding entities of type: ${type}, limit: ${limit}`)
    
    const entities = await kgQuerier.findEntitiesByType(type)
    
    // Apply limit
    const limitedEntities = entities.slice(0, limit)
    
    return c.json({ 
      entities: limitedEntities,
      total: entities.length,
      limit: limit
    })
  } catch (error) {
    Logger.error('Error finding entities by type:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get relationships for an entity
app.get('/relationships/:entityName', async (c) => {
  try {
    const entityName = c.req.param('entityName')
    const limit = parseInt(c.req.query('limit') || '100')
    
    Logger.info(`Finding relationships for entity: ${entityName}, limit: ${limit}`)
    
    const relationships = await kgQuerier.findRelationships(entityName)
    
    // Apply limit
    const limitedRelationships = relationships.slice(0, limit)
    
    return c.json({ 
      relationships: limitedRelationships,
      total: relationships.length,
      limit: limit
    })
  } catch (error) {
    Logger.error('Error finding relationships:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Traverse graph from a starting entity
app.get('/traverse/:startEntity', async (c) => {
  try {
    const startEntity = c.req.param('startEntity')
    const maxDepth = parseInt(c.req.query('depth') || '2')
    
    Logger.info(`Traversing graph from: ${startEntity}, max depth: ${maxDepth}`)
    
    const result = await kgQuerier.traverseGraph(startEntity, maxDepth)
    
    return c.json({
      traversal: result,
      summary: {
        entityCount: result.entities.length,
        relationshipCount: result.relationships.length,
        pathCount: result.paths.length,
        maxDepth: maxDepth
      }
    })
  } catch (error) {
    Logger.error('Error traversing graph:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Search entities by query string
app.get('/search', async (c) => {
  try {
    const query = c.req.query('q')
    const limit = parseInt(c.req.query('limit') || '20')
    
    if (!query) {
      return c.json({ error: 'Query parameter "q" is required' }, 400)
    }
    
    Logger.info(`Searching entities with query: ${query}, limit: ${limit}`)
    
    const entities = await kgQuerier.searchEntities(query)
    
    // Apply limit
    const limitedEntities = entities.slice(0, limit)
    
    return c.json({ 
      entities: limitedEntities,
      total: entities.length,
      limit: limit,
      query: query
    })
  } catch (error) {
    Logger.error('Error searching entities:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get knowledge graph statistics
app.get('/stats', async (c) => {
  try {
    Logger.info('Getting knowledge graph statistics')
    
    const stats = await kgQuerier.getRelationshipStats()
    
    return c.json({ stats })
  } catch (error) {
    Logger.error('Error getting stats:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get visualization data for a specific entity and its neighborhood
app.get('/visualize/:entityName', async (c) => {
  try {
    const entityName = c.req.param('entityName')
    const depth = parseInt(c.req.query('depth') || '2')
    const includeTypes = c.req.query('types')?.split(',') || []
    
    Logger.info(`Getting visualization data for: ${entityName}, depth: ${depth}`)
    
    // Get the traversal result
    const traversalResult = await kgQuerier.traverseGraph(entityName, depth)
    
    // Transform data into visualization format
    const nodes = traversalResult.entities.map(entity => ({
      id: entity.entityName,
      label: entity.entityName,
      type: entity.entityType,
      description: entity.description || '',
      group: entity.entityType,
      // Add size based on connections
      size: traversalResult.relationships.filter(rel => 
        rel.sourceEntityName === entity.entityName || 
        rel.targetEntityName === entity.entityName
      ).length + 10
    }))
    
    const edges = traversalResult.relationships.map((rel, index) => ({
      id: `edge_${index}`,
      source: rel.sourceEntityName,
      target: rel.targetEntityName,
      label: rel.relationshipType,
      type: rel.relationshipType,
      weight: 1
    }))
    
    // Filter by types if specified
    let filteredNodes = nodes
    let filteredEdges = edges
    
    if (includeTypes.length > 0) {
      filteredNodes = nodes.filter(node => includeTypes.includes(node.type))
      const nodeIds = new Set(filteredNodes.map(node => node.id))
      filteredEdges = edges.filter(edge => 
        nodeIds.has(edge.source) && nodeIds.has(edge.target)
      )
    }
    
    return c.json({
      nodes: filteredNodes,
      edges: filteredEdges,
      metadata: {
        centerEntity: entityName,
        depth: depth,
        totalNodes: filteredNodes.length,
        totalEdges: filteredEdges.length,
        entityTypes: [...new Set(filteredNodes.map(n => n.type))],
        relationshipTypes: [...new Set(filteredEdges.map(e => e.type))]
      }
    })
  } catch (error) {
    Logger.error('Error getting visualization data:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get entity types available in the knowledge graph
app.get('/types', async (c) => {
  try {
    Logger.info('Getting available entity types')
    
    const stats = await kgQuerier.getRelationshipStats()
    
    return c.json({
      entityTypes: Object.keys(stats.entityTypes),
      relationshipTypes: Object.keys(stats.relationshipTypes),
      counts: {
        entities: stats.entityTypes,
        relationships: stats.relationshipTypes
      }
    })
  } catch (error) {
    Logger.error('Error getting types:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get overview graph with most connected entities and their relationships
app.get('/overview', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50')
    const minConnections = parseInt(c.req.query('minConnections') || '2')
    
    Logger.info(`Getting overview graph with limit: ${limit}, minConnections: ${minConnections}`)
    
    // Get all relationships to analyze connectivity
    const allRelationships = await kgQuerier.getAllRelationships(200) // Limit to avoid performance issues
    
    // Count connections per entity
    const entityConnections: Record<string, number> = {}
    for (const rel of allRelationships) {
      entityConnections[rel.sourceEntityName] = (entityConnections[rel.sourceEntityName] || 0) + 1
      entityConnections[rel.targetEntityName] = (entityConnections[rel.targetEntityName] || 0) + 1
    }
    
    // Filter entities with minimum connections and sort by connectivity
    const topEntities = Object.entries(entityConnections)
      .filter(([_, count]) => count >= minConnections)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([name]) => name)
    
    // Get entity documents for top entities
    const entities = []
    for (const entityName of topEntities) {
      const entity = await kgQuerier.findEntity(entityName)
      if (entity) {
        entities.push(entity)
      }
    }
    
    // Filter relationships to only include those between our selected entities
    const entitySet = new Set(topEntities)
    const filteredRelationships = allRelationships.filter((rel: any) => 
      entitySet.has(rel.sourceEntityName) && entitySet.has(rel.targetEntityName)
    )
    
    // Transform into visualization format
    const nodes = entities.map(entity => ({
      id: entity.entityName,
      label: entity.entityName,
      type: entity.entityType,
      description: entity.description || '',
      group: entity.entityType,
      size: entityConnections[entity.entityName] || 1
    }))
    
    const edges = filteredRelationships.map((rel: any, index: number) => ({
      id: `edge_${index}`,
      source: rel.sourceEntityName,
      target: rel.targetEntityName,
      label: rel.relationshipType,
      type: rel.relationshipType,
      weight: 1
    }))
    
    return c.json({
      nodes,
      edges,
      metadata: {
        centerEntity: null,
        depth: 1,
        totalNodes: nodes.length,
        totalEdges: edges.length,
        entityTypes: [...new Set(nodes.map(n => n.type))],
        relationshipTypes: [...new Set(edges.map((e: any) => e.type))],
        isOverview: true
      }
    })
  } catch (error) {
    Logger.error('Error getting overview graph:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Get detailed information about a specific relationship
app.get('/relationship-details', async (c) => {
  try {
    const source = c.req.query('source')
    const target = c.req.query('target')
    const type = c.req.query('type')
    
    if (!source || !target) {
      return c.json({ error: 'Source and target parameters are required' }, 400)
    }
    
    Logger.info(`Getting relationship details: ${source} -> ${target} (${type || 'any'})`)
    
    // Get both entities
    const sourceEntity = await kgQuerier.findEntity(source)
    const targetEntity = await kgQuerier.findEntity(target)
    
    // Find the specific relationship
    const relationships = await kgQuerier.findRelationships(source)
    const specificRelationship = relationships.find(rel => 
      rel.targetEntityName === target && 
      (!type || rel.relationshipType === type)
    )
    
    if (!specificRelationship) {
      return c.json({ error: 'Relationship not found' }, 404)
    }
    
    // Get related relationships (other relationships involving these entities)
    const sourceRelationships = await kgQuerier.findRelationships(source)
    const targetRelationships = await kgQuerier.findRelationships(target)
    
    // Filter out the current relationship and combine
    const relatedRelationships = [
      ...sourceRelationships.filter(rel => 
        !(rel.targetEntityName === target && rel.relationshipType === specificRelationship.relationshipType)
      ).slice(0, 5), // Limit to 5 for performance
      ...targetRelationships.filter(rel => 
        !(rel.sourceEntityName === source && rel.relationshipType === specificRelationship.relationshipType)
      ).slice(0, 5)
    ]
    
    return c.json({
      relationship: specificRelationship,
      sourceEntity,
      targetEntity,
      relatedRelationships,
      metadata: {
        hasSourceEntity: !!sourceEntity,
        hasTargetEntity: !!targetEntity,
        relatedCount: relatedRelationships.length
      }
    })
  } catch (error) {
    Logger.error('Error getting relationship details:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default app
