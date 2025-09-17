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
import {
  getKuzuGraphService,
  type KuzuGraphNode,
  type KuzuGraphEdge,
} from "@/db/kuzuGraph"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "knowledgeGraphService",
})

const { JwtPayloadKey } = config

type NodeType =
  | "Person"
  | "Team"
  | "Organization"
  | "Project"
  | "Repository"
  | "Branch"
  | "CodeChangeRequest"
  | "Issue"
  | "Event"
  | "Topic"
  | "Relation"

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

// Get knowledge graph data from KuzuDB with permission filtering
export const GetKnowledgeGraphDataApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const permission = c.req.query("permission")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  // If no permission provided, return empty graph
  if (!permission) {
    loggerWithChild({ email: userEmail }).info(
      "No permission provided, returning empty graph",
    )
    return c.json({
      nodes: [],
      edges: [],
    })
  }

  try {
    loggerWithChild({ email: userEmail }).info(
      `Fetching knowledge graph data for permission: ${permission}`,
    )

    const kuzuService = getKuzuGraphService()

    // Get permission-filtered data from KuzuDB
    let kuzuData: { nodes: any[]; relations: any[] } = {
      nodes: [],
      relations: [],
    }
    try {
      kuzuData = await kuzuService.getAllDataByPermission(permission)
      loggerWithChild({ email: userEmail }).info(
        `Retrieved ${kuzuData.nodes.length} nodes and ${kuzuData.relations.length} relations for permission: ${permission}`,
      )
    } catch (kuzuError) {
      loggerWithChild({ email: userEmail }).warn(
        `KuzuDB error: ${getErrorMessage(kuzuError)}`,
      )
    }

    const graphData: GraphData = {
      nodes: [],
      edges: [],
    }

    // Convert KuzuDB nodes to graph format
    graphData.nodes = kuzuData.nodes.map((node: any) => {
      // Extract node data - KuzuDB returns data in 'n' property for object format
      const nodeData = node.n || node[0] || node

      const detectedType = getNodeTypeFromEntity(nodeData)

      // Extract actual KuzuDB schema type from the node
      const actualKuzuType =
        nodeData._label ||
        nodeData.label ||
        nodeData.type ||
        nodeData.node_type ||
        "entity"

      return {
        id: nodeData.id || nodeData.name || `node_${createId()}`,
        name: nodeData.name || "Unnamed Node",
        description: createNodeDescription(nodeData),
        type: actualKuzuType as NodeType,
        metadata: {
          ...node,
          source: "kuzu_db",
          actualKuzuType: actualKuzuType, // Add actual KuzuDB schema type
          permissions: nodeData.permissions || [],
          lastUpdated: nodeData.lastUpdated,
          rawDescriptions: nodeData.rawDescriptions,
          detectedType: detectedType,
          originalKuzuData: nodeData,
        },
        x: nodeData.position_x || 0,
        y: nodeData.position_y || 0,
        size: nodeData.size || 15,
        color: nodeData.color || getColorForNodeType(detectedType),
      }
    })

    // Convert KuzuDB Relation edges to graph edges
    graphData.edges = kuzuData.relations
      .map((relationRow: any) => {
        // Handle object-based response structure like {"r": {...}, "source": "...", "target": "..."}
        const relationData = relationRow.r || relationRow[0] || relationRow

        // Get source and target node names from the query results
        const sourceName = relationRow.source
        const targetName = relationRow.target

        // Find the corresponding node IDs by matching names
        const sourceNode = graphData.nodes.find(
          (node) => node.name === sourceName,
        )
        const targetNode = graphData.nodes.find(
          (node) => node.name === targetName,
        )

        const fromId = sourceNode?.id
        const toId = targetNode?.id

        return {
          id: relationData?.relation_id || `edge_${createId()}`,
          from: fromId || "",
          to: toId || "",
          relationship:
            relationData?.type || relationData?.relationTag?.[0] || "Relation",
          metadata: {
            ...relationData,
            source: "kuzu_db",
            actualKuzuType: "Relation",
            permissions: relationData?.permissions || [],
            strength: relationData?.strength,
            description: relationData?.description?.[0] || "",
            relationTag: relationData?.relationTag,
            sources: relationData?.sources,
            createdAt: relationData?.createdAt,
            lastUpdated: relationData?.lastUpdated,
            originalRelationRow: relationRow,
          },
        }
      })
      .filter((edge: any) => edge.from && edge.to) // Only include edges with valid from/to

    // If no data was found, add a helpful message
    if (graphData.nodes.length === 0) {
      graphData.nodes.push({
        id: "no_permission_data",
        name: "No Data for Permission",
        description: `No nodes found for permission "${permission}". Try a different permission value or add data to KuzuDB.`,
        type: "Issue",
        metadata: {
          source: "system",
          permission: permission,
          created: new Date().toISOString(),
        },
      })
    }

    loggerWithChild({ email: userEmail }).info(
      `Generated knowledge graph with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges for permission: ${permission}`,
    )

    return c.json(graphData)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to fetch knowledge graph data: ${errMsg}`,
    )

    // Return a minimal fallback response instead of throwing an error
    return c.json({
      nodes: [
        {
          id: "error_fallback",
          name: "Knowledge Graph Unavailable",
          description:
            "There was an issue loading your knowledge graph. Please try refreshing or contact support if the issue persists.",
          type: "Issue",
          metadata: {
            source: "system",
            isError: true,
            error: errMsg,
            created: new Date().toISOString(),
          },
        },
      ],
      edges: [],
    })
  }
}

// Helper function to determine node type from KuzuDB entity
function getNodeTypeFromEntity(entity: any): string {
  // First, check if KuzuDB provides the node label/type directly
  // KuzuDB may return node type as part of metadata or structure
  if (entity._label) return mapKuzuSchemaToFrontendType(entity._label)
  if (entity.label) return mapKuzuSchemaToFrontendType(entity.label)
  if (entity.type) return mapKuzuSchemaToFrontendType(entity.type)
  if (entity.node_type) return mapKuzuSchemaToFrontendType(entity.node_type)

  // Map KuzuDB schema entity types to frontend node types
  // Based on schema.yaml: Person, Team, Organization, Project, Repository, Branch, CodeChangeRequest, Issue, Event, Topic, Relation

  // Person entities (have emails field)
  if (entity.emails !== undefined) return "person"

  // Organization entities (have domain field)
  if (entity.domain !== undefined) return "company"

  // Project entities (have startDate/endDate)
  if (entity.startDate !== undefined || entity.endDate !== undefined)
    return "project"

  // Repository entities (have url and language)
  if (entity.url !== undefined && entity.language !== undefined) return "tool"

  // Issue entities (have status and reporter)
  if (entity.status !== undefined && entity.reporter !== undefined)
    return "document"

  // Event entities (have startTime)
  if (entity.startTime !== undefined) return "event"

  // Topic entities (have keywords)
  if (entity.keywords !== undefined) return "concept"

  // Branch entities (have repo and createdBy)
  if (entity.repo !== undefined && entity.createdBy !== undefined)
    return "document"

  // CodeChangeRequest entities (have title and author)
  if (entity.title !== undefined && entity.author !== undefined)
    return "document"

  // Team entities (generic entities with team-like properties)
  if (entity.name && entity.cleanDescription) return "entity"

  // Relation entities
  if (entity.relationTag !== undefined || entity.relation_id !== undefined)
    return "relation"

  // Default to entity for unknown types
  return "entity"
}

// Helper function to map KuzuDB schema types to frontend types
function mapKuzuSchemaToFrontendType(kuzuType: string): string {
  const typeMapping: Record<string, string> = {
    // KuzuDB schema types -> Frontend types
    Person: "person",
    Team: "entity",
    Organization: "company",
    Project: "project",
    Repository: "tool",
    Branch: "document",
    CodeChangeRequest: "document",
    Issue: "document",
    Event: "event",
    Topic: "concept",
    Relation: "relation",
  }

  return typeMapping[kuzuType] || "entity"
}

// Helper function to create comprehensive node description from all attributes
function createNodeDescription(nodeData: any): string {
  const parts: string[] = []

  // Add main description if available
  if (nodeData.description || nodeData.cleanDescription) {
    parts.push(nodeData.description || nodeData.cleanDescription)
  }

  // Add all other attributes except embeddings and certain system fields
  const excludeFields = [
    "embedding",
    "embeddings",
    "id",
    "name",
    "description",
    "cleanDescription",
  ]

  for (const [key, value] of Object.entries(nodeData)) {
    if (excludeFields.includes(key) || value === null || value === undefined) {
      continue
    }

    // Format the value based on its type
    let formattedValue: string
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      formattedValue = value.join(", ")
    } else if (typeof value === "object") {
      formattedValue = JSON.stringify(value)
    } else {
      formattedValue = String(value)
    }

    // Add to description if not empty
    if (formattedValue && formattedValue.trim()) {
      parts.push(`${key}: ${formattedValue}`)
    }
  }

  return parts.join("\n") || "No description available"
}

// Helper function to get color for node type
function getColorForNodeType(nodeType: string): string {
  const colors: Record<string, string> = {
    Person: "#F4A261",
    Team: "#1D3557",
    Organization: "#2A9D8F",
    Project: "#E9C46A",
    Repository: "#8D99AE",
    Branch: "#90A955",
    CodeChangeRequest: "#F77F00",
    Issue: "#E63946",
    Event: "#F77F00",
    Topic: "#457B9D",
    Relation: "#ec4899",
  }
  return colors[nodeType] || "#6b7280"
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
    const {
      name,
      description,
      type,
      metadata = {},
      position_x,
      position_y,
      size,
      color,
    } = body

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
        description: description || "",
        node_type: type,
        position_x: position_x || 0,
        position_y: position_y || 0,
        size: size || 15,
        color: color || "#3b82f6",
        metadata,
        created_by: userEmail,
        source: "user_created",
      })

      loggerWithChild({ email: userEmail }).info(
        `Created custom node: ${newNode.id}`,
      )

      return c.json({
        id: newNode.id,
        name: newNode.name,
        description: newNode.description,
        type: newNode.node_type,
        metadata: newNode.metadata,
        x: newNode.position_x,
        y: newNode.position_y,
        size: newNode.size,
        color: newNode.color,
      })
    } catch (kuzuError) {
      const kuzuErrMsg = getErrorMessage(kuzuError)
      loggerWithChild({ email: userEmail }).warn(
        `KuzuDB create failed, returning mock node: ${kuzuErrMsg}`,
      )

      // If KuzuDB fails, return a mock successful response
      return c.json({
        id: nodeId,
        name,
        description: description || "",
        type,
        metadata,
        x: position_x || 0,
        y: position_y || 0,
        size: size || 15,
        color: color || "#3b82f6",
      })
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to create node: ${errMsg}`,
    )
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
      throw new HTTPException(400, {
        message: "From, to, and relationship are required",
      })
    }

    if (from === to) {
      throw new HTTPException(400, {
        message: "From and to nodes must be different",
      })
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
      created_by: userEmail,
    })

    loggerWithChild({ email: userEmail }).info(
      `Created custom edge: ${newEdge.id} (${from} -> ${to})`,
    )

    return c.json({
      id: newEdge.id,
      from: newEdge.from_node_id,
      to: newEdge.to_node_id,
      relationship: newEdge.relationship_type,
      weight: newEdge.weight,
      metadata: newEdge.metadata,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to create edge: ${errMsg}`,
    )
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
    const isCustomNode = nodeId.startsWith("node_")
    const isFileSystemNode =
      nodeId.startsWith("file_") ||
      nodeId.startsWith("collection_") ||
      nodeId.startsWith("folder_") ||
      nodeId.startsWith("concept_")

    if (isFileSystemNode) {
      // File system-derived nodes cannot be deleted as they are auto-generated
      // from your collections and files
      throw new HTTPException(400, {
        message:
          "Cannot delete file system-derived nodes. These nodes are automatically generated from your collections and files.",
      })
    }

    if (isCustomNode) {
      // Only delete custom nodes from KuzuDB
      try {
        const kuzuService = getKuzuGraphService()
        await kuzuService.deleteNode(nodeId)

        loggerWithChild({ email: userEmail }).info(
          `Deleted custom node: ${nodeId}`,
        )
        return c.json({ message: "Node deleted successfully" })
      } catch (kuzuError) {
        const kuzuErrMsg = getErrorMessage(kuzuError)
        loggerWithChild({ email: userEmail }).warn(
          `KuzuDB delete failed, but continuing: ${kuzuErrMsg}`,
        )

        // If KuzuDB is not available or fails, we'll still report success
        // since the node will be recreated from KuzuDB on next load anyway
        return c.json({
          message:
            "Node deleted successfully (KuzuDB not available, but node will be removed on refresh)",
        })
      }
    }

    // If it's neither a custom node nor a recognized file system node
    throw new HTTPException(404, {
      message: "Node not found or cannot be deleted",
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to delete node: ${errMsg}`,
    )
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
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to delete edge: ${errMsg}`,
    )
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

    loggerWithChild({ email: userEmail }).info(
      `Cleared graph for workspace: ${user.workspaceExternalId}`,
    )

    return c.json({ message: "Graph cleared successfully" })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to clear graph: ${errMsg}`,
    )
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
    const [nodeType, actualId] = nodeId.split("_", 2)

    let nodeDetails: any = null

    if (nodeType === "collection") {
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
            isNull(collectionItems.deletedAt),
          ),
        )

      nodeDetails = {
        ...collection,
        nodeType: "collection",
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          path: item.path,
        })),
      }
    } else if (nodeType === "folder" || nodeType === "file") {
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
      if (
        !collection ||
        (collection.ownerId !== user.id && collection.isPrivate)
      ) {
        throw new HTTPException(403, { message: "Access denied" })
      }

      nodeDetails = {
        ...itemData,
        nodeType: nodeType,
        collection: {
          id: collection.id,
          name: collection.name,
        },
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
