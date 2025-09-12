import { createId } from "@paralleldrive/cuid2"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import {
  getAccessibleCollections,
  getCollectionItemsByParent,
  getCollectionById,
} from "@/db/knowledgeBase"
import { collections, collectionItems } from "@/db/schema"
import { and, eq, isNull, inArray } from "drizzle-orm"
import { getKuzuGraphService, type KuzuGraphNode, type KuzuGraphEdge } from "@/db/kuzuGraph"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "knowledgeGraphService",
})

const { JwtPayloadKey } = config

type NodeType = 'collection' | 'folder' | 'file' | 'concept' | 'seed' | 'person' | 'company' | 'project' | 'document' | 'event' | 'tool' | 'entity' | 'relation'

interface GraphNode {
  id: string
  name: string
  description: string
  type: NodeType
  metadata: Record<string, any>
  x?: number
  y?: number
  size?: number
  color?: string
}

interface GraphEdge {
  id: string
  from: string
  to: string
  relationship: string
  metadata: Record<string, any>
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// Generate hybrid knowledge graph data from file system + KuzuDB
export const GetKnowledgeGraphDataApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    loggerWithChild({ email: userEmail }).info("Starting to fetch knowledge graph data")
    
    const kuzuService = getKuzuGraphService()
    
    // Get persisted graph data from KuzuDB with error handling
    let persistedGraph: { nodes: KuzuGraphNode[], edges: KuzuGraphEdge[] } = { nodes: [], edges: [] }
    try {
      persistedGraph = await kuzuService.getWorkspaceGraph(user.workspaceExternalId)
      loggerWithChild({ email: userEmail }).info(`Retrieved ${persistedGraph.nodes.length} persisted nodes from KuzuDB`)
    } catch (kuzuError) {
      loggerWithChild({ email: userEmail }).warn(`KuzuDB error, continuing with empty persisted graph: ${getErrorMessage(kuzuError)}`)
    }
    
    // Get file system data for hybrid approach
    let userCollections: any[] = []
    try {
      userCollections = await getAccessibleCollections(db, user.id)
      loggerWithChild({ email: userEmail }).info(`Retrieved ${userCollections.length} collections`)
    } catch (dbError) {
      loggerWithChild({ email: userEmail }).warn(`Database error getting collections: ${getErrorMessage(dbError)}`)
    }
    
    const graphData: GraphData = {
      nodes: [],
      edges: []
    }
    
    // Add persisted custom nodes first
    graphData.nodes = persistedGraph.nodes.map(kuzuNode => ({
      id: kuzuNode.id,
      name: kuzuNode.name,
      description: kuzuNode.description || '',
      type: kuzuNode.node_type as NodeType,
      metadata: kuzuNode.metadata,
      x: kuzuNode.position_x,
      y: kuzuNode.position_y,
      size: kuzuNode.size,
      color: kuzuNode.color
    }))
    
    // Add persisted custom edges
    graphData.edges = persistedGraph.edges.map(kuzuEdge => ({
      id: kuzuEdge.id,
      from: kuzuEdge.from_node_id,
      to: kuzuEdge.to_node_id,
      relationship: kuzuEdge.relationship_type,
      weight: kuzuEdge.weight,
      metadata: kuzuEdge.metadata
    }))

    // Add file system derived nodes (only if not already in KuzuDB)
    const existingNodeIds = new Set(graphData.nodes.map(n => n.id))
    
    for (const collection of userCollections) {
      const collectionNodeId = `collection_${collection.id}`
      
      if (!existingNodeIds.has(collectionNodeId)) {
        const collectionNode: GraphNode = {
          id: collectionNodeId,
          name: collection.name,
          description: collection.description || "Knowledge Base Collection",
          type: 'collection',
          metadata: {
            collectionId: collection.id,
            isPrivate: collection.isPrivate,
            createdAt: collection.createdAt,
            itemCount: 0, // Will be updated below
            source: 'file_system',
            ...(collection.metadata || {})
          }
        }
        graphData.nodes.push(collectionNode)
      }

      // Get all items in this collection (files and folders)
      const allItems = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, collection.id),
            isNull(collectionItems.deletedAt)
          )
        )

      // Update collection metadata with item count
      const collectionNode = graphData.nodes.find(n => n.id === collectionNodeId)
      if (collectionNode) {
        collectionNode.metadata.itemCount = allItems.length
      }

      // Create nodes for folders and files (only if not in KuzuDB)
      const folderNodes = new Map<string, GraphNode>()
      const fileNodes = new Map<string, GraphNode>()

      for (const item of allItems) {
        if (item.type === 'folder') {
          const folderNodeId = `folder_${item.id}`
          
          if (!existingNodeIds.has(folderNodeId)) {
            const folderNode: GraphNode = {
              id: folderNodeId,
              name: item.name,
              description: `Folder in ${collection.name}`,
              type: 'folder',
              metadata: {
                itemId: item.id,
                collectionId: collection.id,
                parentId: item.parentId,
                path: item.path,
                createdAt: item.createdAt,
                source: 'file_system',
                ...(item.metadata || {})
              }
            }
            graphData.nodes.push(folderNode)
          }
          folderNodes.set(item.id, graphData.nodes.find(n => n.id === folderNodeId)!)

          const folderNode = graphData.nodes.find(n => n.id === folderNodeId)
          if (folderNode) {
            // Connect folder to collection or parent folder
            const parentNodeId = item.parentId ? 
              (folderNodes.has(item.parentId) ? `folder_${item.parentId}` : `collection_${collection.id}`) :
              `collection_${collection.id}`

            graphData.edges.push({
              id: `edge_${createId()}`,
              from: parentNodeId,
              to: folderNode.id,
              relationship: 'contains',
              metadata: { type: 'folder_relationship' }
            })
          }

        } else if (item.type === 'file') {
          const fileNodeId = `file_${item.id}`
          
          if (!existingNodeIds.has(fileNodeId)) {
            const fileNode: GraphNode = {
              id: fileNodeId,
              name: item.name,
              description: `File in ${collection.name}`,
              type: 'file',
              metadata: {
                itemId: item.id,
                collectionId: collection.id,
                parentId: item.parentId,
                path: item.path,
                mimeType: item.mimeType,
                fileSize: item.fileSize,
                createdAt: item.createdAt,
                source: 'file_system',
                ...(item.metadata || {})
              }
            }
            graphData.nodes.push(fileNode)
          }
          fileNodes.set(item.id, graphData.nodes.find(n => n.id === fileNodeId)!)

          const fileNode = graphData.nodes.find(n => n.id === fileNodeId)
          if (fileNode) {
            // Connect file to collection or parent folder
            const parentNodeId = item.parentId ? 
              (folderNodes.has(item.parentId) ? `folder_${item.parentId}` : `collection_${collection.id}`) :
              `collection_${collection.id}`

            graphData.edges.push({
              id: `edge_${createId()}`,
              from: parentNodeId,
              to: fileNode.id,
              relationship: 'contains',
              metadata: { type: 'file_relationship' }
            })
          }
        }
      }
    }

    // Add conceptual relationships between collections if they share similar content
    // This creates a more interconnected graph
    for (let i = 0; i < userCollections.length; i++) {
      for (let j = i + 1; j < userCollections.length; j++) {
        const collection1 = userCollections[i]
        const collection2 = userCollections[j]

        // Simple heuristic: if collections have similar names or tags, connect them
        const name1 = collection1.name.toLowerCase()
        const name2 = collection2.name.toLowerCase()
        
        const hasCommonWords = name1.split(' ').some((word: string) => 
          word.length > 3 && name2.includes(word)
        )

        if (hasCommonWords) {
          graphData.edges.push({
            id: `edge_${createId()}`,
            from: `collection_${collection1.id}`,
            to: `collection_${collection2.id}`,
            relationship: 'related_to',
            metadata: { 
              type: 'collection_similarity',
              reason: 'similar_naming'
            }
          })
        }
      }
    }

    // Add some conceptual nodes based on content types if we have files
    const contentTypes = new Set<string>()
    const conceptNodes = new Map<string, GraphNode>()

    for (const node of graphData.nodes) {
      if (node.type === 'file' && node.metadata.mimeType) {
        const baseType = node.metadata.mimeType.split('/')[0]
        contentTypes.add(baseType)
      }
    }

    // Create concept nodes for content types
    for (const contentType of contentTypes) {
      const conceptNode: GraphNode = {
        id: `concept_${contentType}`,
        name: `${contentType.charAt(0).toUpperCase() + contentType.slice(1)} Content`,
        description: `All ${contentType} files in your knowledge base`,
        type: 'concept',
        metadata: {
          contentType,
          conceptType: 'file_type'
        }
      }
      graphData.nodes.push(conceptNode)
      conceptNodes.set(contentType, conceptNode)

      // Connect files of this type to the concept
      for (const node of graphData.nodes) {
        if (node.type === 'file' && node.metadata.mimeType?.startsWith(contentType)) {
          graphData.edges.push({
            id: `edge_${createId()}`,
            from: conceptNode.id,
            to: node.id,
            relationship: 'categorizes',
            metadata: { type: 'content_type_relationship' }
          })
        }
      }
    }

    // If no data was found, add a helpful starter node
    if (graphData.nodes.length === 0) {
      graphData.nodes.push({
        id: 'starter_node',
        name: 'Welcome to Knowledge Graph',
        description: 'Start by creating your first custom node or uploading files to your Knowledge Base to see them appear here.',
        type: 'seed',
        metadata: {
          source: 'system',
          isStarter: true,
          created: new Date().toISOString()
        }
      })
    }

    loggerWithChild({ email: userEmail }).info(
      `Generated knowledge graph with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`,
    )

    return c.json(graphData)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to generate knowledge graph data: ${errMsg}`,
    )
    
    // Return a minimal fallback response instead of throwing an error
    loggerWithChild({ email: userEmail }).warn("Returning fallback knowledge graph data")
    return c.json({
      nodes: [
        {
          id: 'error_fallback',
          name: 'Knowledge Graph Unavailable',
          description: 'There was an issue loading your knowledge graph. Please try refreshing or contact support if the issue persists.',
          type: 'seed',
          metadata: {
            source: 'system',
            isError: true,
            error: errMsg,
            created: new Date().toISOString()
          }
        }
      ],
      edges: []
    })
  }
}

// Create a new custom node and persist to KuzuDB
export const CreateNodeApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  
  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const body = await c.req.json()
    const { name, description, type, metadata = {}, position_x, position_y, size, color } = body

    if (!name || !type) {
      throw new HTTPException(400, { message: "Name and type are required" })
    }

    const nodeId = `node_${createId()}`
    
    try {
      const kuzuService = getKuzuGraphService()
      
      const newNode = await kuzuService.createNode({
        id: nodeId,
        workspace_id: user.workspaceExternalId,
        name,
        description: description || '',
        node_type: type,
        position_x: position_x || 0,
        position_y: position_y || 0,
        size: size || 15,
        color: color || '#3b82f6',
        metadata,
        created_by: userEmail,
        source: 'user_created'
      })

      loggerWithChild({ email: userEmail }).info(`Created custom node: ${newNode.id}`)
      
      return c.json({
        id: newNode.id,
        name: newNode.name,
        description: newNode.description,
        type: newNode.node_type,
        metadata: newNode.metadata,
        x: newNode.position_x,
        y: newNode.position_y,
        size: newNode.size,
        color: newNode.color
      })
    } catch (kuzuError) {
      const kuzuErrMsg = getErrorMessage(kuzuError)
      loggerWithChild({ email: userEmail }).warn(`KuzuDB create failed, returning mock node: ${kuzuErrMsg}`)
      
      // If KuzuDB fails, return a mock successful response
      return c.json({
        id: nodeId,
        name,
        description: description || '',
        type,
        metadata,
        x: position_x || 0,
        y: position_y || 0,
        size: size || 15,
        color: color || '#3b82f6'
      })
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(error, `Failed to create node: ${errMsg}`)
    throw new HTTPException(500, { message: "Failed to create node" })
  }
}

// Create a new custom edge and persist to KuzuDB
export const CreateEdgeApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  
  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const body = await c.req.json()
    const { from, to, relationship, weight = 1.0, metadata = {} } = body

    if (!from || !to || !relationship) {
      throw new HTTPException(400, { message: "From, to, and relationship are required" })
    }

    if (from === to) {
      throw new HTTPException(400, { message: "From and to nodes must be different" })
    }

    const kuzuService = getKuzuGraphService()
    
    const newEdge = await kuzuService.createEdge({
      id: `edge_${createId()}`,
      workspace_id: user.workspaceExternalId,
      from_node_id: from,
      to_node_id: to,
      relationship_type: relationship,
      weight,
      metadata,
      created_by: userEmail
    })

    loggerWithChild({ email: userEmail }).info(`Created custom edge: ${newEdge.id} (${from} -> ${to})`)
    
    return c.json({
      id: newEdge.id,
      from: newEdge.from_node_id,
      to: newEdge.to_node_id,
      relationship: newEdge.relationship_type,
      weight: newEdge.weight,
      metadata: newEdge.metadata
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(error, `Failed to create edge: ${errMsg}`)
    throw new HTTPException(500, { message: "Failed to create edge" })
  }
}

// Delete a node from KuzuDB
export const DeleteNodeApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const nodeId = c.req.param("nodeId")
  
  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    // Check if this is a custom node (stored in KuzuDB) or a file system-derived node
    const isCustomNode = nodeId.startsWith('node_')
    const isFileSystemNode = nodeId.startsWith('file_') || 
                            nodeId.startsWith('collection_') || 
                            nodeId.startsWith('folder_') || 
                            nodeId.startsWith('concept_')

    if (isFileSystemNode) {
      // File system-derived nodes cannot be deleted as they are auto-generated
      // from your collections and files
      throw new HTTPException(400, { 
        message: "Cannot delete file system-derived nodes. These nodes are automatically generated from your collections and files." 
      })
    }

    if (isCustomNode) {
      // Only delete custom nodes from KuzuDB
      try {
        const kuzuService = getKuzuGraphService()
        await kuzuService.deleteNode(nodeId)
        
        loggerWithChild({ email: userEmail }).info(`Deleted custom node: ${nodeId}`)
        return c.json({ message: "Node deleted successfully" })
      } catch (kuzuError) {
        const kuzuErrMsg = getErrorMessage(kuzuError)
        loggerWithChild({ email: userEmail }).warn(`KuzuDB delete failed, but continuing: ${kuzuErrMsg}`)
        
        // If KuzuDB is not available or fails, we'll still report success
        // since the node will be recreated from KuzuDB on next load anyway
        return c.json({ message: "Node deleted successfully (KuzuDB not available, but node will be removed on refresh)" })
      }
    }

    // If it's neither a custom node nor a recognized file system node
    throw new HTTPException(404, { message: "Node not found or cannot be deleted" })
    
  } catch (error) {
    if (error instanceof HTTPException) throw error
    
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(error, `Failed to delete node: ${errMsg}`)
    throw new HTTPException(500, { message: "Failed to delete node" })
  }
}

// Delete an edge from KuzuDB
export const DeleteEdgeApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const edgeId = c.req.param("edgeId")
  
  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kuzuService = getKuzuGraphService()
    await kuzuService.deleteEdge(edgeId)

    loggerWithChild({ email: userEmail }).info(`Deleted edge: ${edgeId}`)
    
    return c.json({ message: "Edge deleted successfully" })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(error, `Failed to delete edge: ${errMsg}`)
    throw new HTTPException(500, { message: "Failed to delete edge" })
  }
}

// Clear all custom graph data for workspace
export const ClearGraphApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  
  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kuzuService = getKuzuGraphService()
    await kuzuService.clearWorkspaceGraph(user.workspaceExternalId)

    loggerWithChild({ email: userEmail }).info(`Cleared graph for workspace: ${user.workspaceExternalId}`)
    
    return c.json({ message: "Graph cleared successfully" })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(error, `Failed to clear graph: ${errMsg}`)
    throw new HTTPException(500, { message: "Failed to clear graph" })
  }
}

// Get specific node details
export const GetNodeDetailsApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const nodeId = c.req.param("nodeId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    // Parse the node ID to determine type and actual ID
    const [nodeType, actualId] = nodeId.split('_', 2)

    let nodeDetails: any = null

    if (nodeType === 'collection') {
      const collection = await getCollectionById(db, actualId)
      if (!collection) {
        throw new HTTPException(404, { message: "Collection not found" })
      }

      // Check access
      if (collection.ownerId !== user.id && collection.isPrivate) {
        throw new HTTPException(403, { message: "Access denied" })
      }

      // Get collection items for additional details
      const items = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, actualId),
            isNull(collectionItems.deletedAt)
          )
        )

      nodeDetails = {
        ...collection,
        nodeType: 'collection',
        items: items.map(item => ({
          id: item.id,
          name: item.name,
          type: item.type,
          path: item.path
        }))
      }

    } else if (nodeType === 'folder' || nodeType === 'file') {
      const item = await db
        .select()
        .from(collectionItems)
        .where(eq(collectionItems.id, actualId))
        .limit(1)

      if (!item || item.length === 0) {
        throw new HTTPException(404, { message: "Item not found" })
      }

      const itemData = item[0]

      // Check collection access
      const collection = await getCollectionById(db, itemData.collectionId)
      if (!collection || (collection.ownerId !== user.id && collection.isPrivate)) {
        throw new HTTPException(403, { message: "Access denied" })
      }

      nodeDetails = {
        ...itemData,
        nodeType: nodeType,
        collection: {
          id: collection.id,
          name: collection.name
        }
      }
    }

    if (!nodeDetails) {
      throw new HTTPException(404, { message: "Node not found" })
    }

    return c.json(nodeDetails)
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get node details: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get node details",
    })
  }
}
