import path from 'path';
import fs from 'fs';
import { getLogger } from '@/logger';
import { Subsystem } from '@/types';

const logger = getLogger(Subsystem.Db);

// KuzuDB HTTP endpoint
const KUZU_DB_URL = process.env.KUZU_DB_URL || 'http://localhost:7000';

// Load schema from JSON file
const schemaPath = path.join(process.cwd(), 'knowledge-graph', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

// Helper function to execute KuzuDB Cypher queries via HTTP
async function executeKuzuQuery(query: string, parameters: Record<string, any> = {}): Promise<any> {
  try {
    const response = await fetch(`${KUZU_DB_URL}/cypher`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, parameters }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`KuzuDB query failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    logger.error(error, `Failed to execute KuzuDB query: ${query}`);
    throw error;
  }
}

// Test kuzu availability on startup
let kuzuAvailable = false;
(async () => {
  try {
    // Just test connection without creating schema
    await executeKuzuQuery('MATCH (n) RETURN count(n) as nodeCount LIMIT 1');
    kuzuAvailable = true;
    logger.info('KuzuDB (HTTP) connection established');
  } catch (error) {
    logger.warn('KuzuDB (HTTP) not available - will operate in read-only mode');
    kuzuAvailable = false;
  }
})();

// Graph node interface for KuzuDB
export interface KuzuGraphNode {
  id: string;
  workspace_id: string;
  name: string;
  description?: string;
  node_type: string;
  position_x?: number;
  position_y?: number;
  size?: number;
  color?: string;
  metadata: any;
  created_by?: string;
  created_at: string;
  updated_at: string;
  source: 'file_system' | 'user_created';
}

// Graph edge interface for KuzuDB
export interface KuzuGraphEdge {
  id: string;
  workspace_id: string;
  from_node_id: string;
  to_node_id: string;
  relationship_type: string;
  weight?: number;
  metadata: any;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

class KuzuGraphService {
  private isInitialized = true; // Always initialized since we use Python

  constructor() {
    // No initialization needed - using Python subprocess
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('KuzuDB not initialized');
    }
  }

  async createNode(node: Omit<KuzuGraphNode, 'created_at' | 'updated_at'>): Promise<KuzuGraphNode> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const nodeWithTimestamps: KuzuGraphNode = {
      ...node,
      created_at: now,
      updated_at: now,
    };

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Created node ${nodeWithTimestamps.id} (not persisted)`);
      return nodeWithTimestamps;
    }

    try {
      const params = {
        id: nodeWithTimestamps.id,
        workspace_id: nodeWithTimestamps.workspace_id,
        name: nodeWithTimestamps.name,
        description: nodeWithTimestamps.description || '',
        node_type: nodeWithTimestamps.node_type,
        position_x: nodeWithTimestamps.position_x || 0,
        position_y: nodeWithTimestamps.position_y || 0,
        size: nodeWithTimestamps.size || 15,
        color: nodeWithTimestamps.color || '#3b82f6',
        metadata: JSON.stringify(nodeWithTimestamps.metadata || {}),
        created_by: nodeWithTimestamps.created_by || '',
        created_at: nodeWithTimestamps.created_at,
        updated_at: nodeWithTimestamps.updated_at,
        source: nodeWithTimestamps.source,
      };

      const nodeType = nodeWithTimestamps.node_type;
      const properties = schema[nodeType];
      const queryParts: string[] = [];
      const queryParams: Record<string, any> = {};

      for (const propName in properties) {
        if (propName.includes('PRIMARY KEY')) {
          const actualPropName = propName.replace(' PRIMARY KEY', '').trim();
          queryParts.push(`${actualPropName}: $${actualPropName}`);
          queryParams[actualPropName] = (nodeWithTimestamps as any)[actualPropName];
        } else {
          queryParts.push(`${propName}: $${propName}`);
          queryParams[propName] = (nodeWithTimestamps as any)[propName];
        }
      }
      
      const createNodeQuery = `CREATE (n:${nodeType} {${queryParts.join(', ')}})`;
      await executeKuzuQuery(createNodeQuery, queryParams);
      logger.info(`Created node ${nodeWithTimestamps.id} in KuzuDB`);
      return nodeWithTimestamps;
    } catch (error) {
      logger.error(error, `Failed to create node ${nodeWithTimestamps.id} in KuzuDB`);
      throw error;
    }
  }

  async createEdge(edge: Omit<KuzuGraphEdge, 'created_at' | 'updated_at'>): Promise<KuzuGraphEdge> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const edgeWithTimestamps: KuzuGraphEdge = {
      ...edge,
      created_at: now,
      updated_at: now,
    };

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Created edge ${edgeWithTimestamps.id} (not persisted)`);
      return edgeWithTimestamps;
    }

    try {
      const params = {
        from_node_id: edgeWithTimestamps.from_node_id,
        to_node_id: edgeWithTimestamps.to_node_id,
        edge_id: edgeWithTimestamps.id,
        workspace_id: edgeWithTimestamps.workspace_id,
        relationship_type: edgeWithTimestamps.relationship_type,
        weight: edgeWithTimestamps.weight || 1.0,
        metadata: JSON.stringify(edgeWithTimestamps.metadata || {}),
        created_by: edgeWithTimestamps.created_by || '',
        created_at: edgeWithTimestamps.created_at,
        updated_at: edgeWithTimestamps.updated_at,
      };

      const edgeProperties = schema['Relation'];
      const queryParts: string[] = [];
      const queryParams: Record<string, any> = {};

      for (const propName in edgeProperties) {
        if (propName === 'FROM' || propName === 'TO' || propName.includes('PRIMARY KEY')) continue;
        queryParts.push(`${propName}: $${propName}`);
        queryParams[propName] = (edgeWithTimestamps as any)[propName];
      }
      queryParams['from_node_id'] = edgeWithTimestamps.from_node_id;
      queryParams['to_node_id'] = edgeWithTimestamps.to_node_id;

      const createEdgeQuery = `MATCH (a:${edgeWithTimestamps.from_node_id} {id: $from_node_id}), (b:${edgeWithTimestamps.to_node_id} {id: $to_node_id}) CREATE (a)-[r:CONNECTS {${queryParts.join(', ')}}]->(b)`;
      await executeKuzuQuery(createEdgeQuery, queryParams);
      logger.info(`Created edge ${edgeWithTimestamps.id} in KuzuDB`);
      return edgeWithTimestamps;
    } catch (error) {
      logger.error(error, `Failed to create edge ${edgeWithTimestamps.id} in KuzuDB`);
      throw error;
    }
  }

  async getWorkspaceGraph(workspaceId: string): Promise<{ nodes: KuzuGraphNode[], edges: KuzuGraphEdge[] }> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Retrieved empty graph for workspace ${workspaceId}`);
      return { nodes: [], edges: [] };
    }

    try {
      const nodesResult = await executeKuzuQuery('MATCH (n) WHERE n.workspace_id = $workspace_id RETURN n as nodeData', { workspace_id: workspaceId });
      const edgesResult = await executeKuzuQuery('MATCH (a)-[r:CONNECTS]->(b) WHERE r.workspace_id = $workspace_id RETURN r as edgeData, a.id as sourceId, b.id as targetId', { workspace_id: workspaceId });

      const nodes: KuzuGraphNode[] = nodesResult.rows.map((row: any) => {
        const node = row.nodeData;
        return {
          id: node.id,
          workspace_id: node.workspace_id,
          name: node.name,
          description: node.description,
          node_type: node.node_type,
          position_x: node.position_x,
          position_y: node.position_y,
          size: node.size,
          color: node.color,
          metadata: JSON.parse(node.metadata || '{}'),
          created_by: node.created_by,
          created_at: node.created_at,
          updated_at: node.updated_at,
          source: node.source,
        };
      });

      const edges: KuzuGraphEdge[] = edgesResult.rows.map((row: any) => {
        const edge = row.edgeData;
        return {
          id: edge.id,
          workspace_id: edge.workspace_id,
          from_node_id: row.sourceId,
          to_node_id: row.targetId,
          relationship_type: edge.relationship_type,
          weight: edge.weight,
          metadata: JSON.parse(edge.metadata || '{}'),
          created_by: edge.created_by,
          created_at: edge.created_at,
          updated_at: edge.updated_at,
        };
      });

      logger.info(`Retrieved ${nodes.length} nodes and ${edges.length} edges for workspace ${workspaceId}`);
      return { nodes, edges };
    } catch (error) {
      logger.error(error, `Failed to retrieve graph for workspace ${workspaceId}`);
      throw error;
    }
  }

  async deleteNode(nodeId: string): Promise<void> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Deleted node ${nodeId} (not persisted)`);
      return;
    }

    try {
      await executeKuzuQuery('MATCH (n) WHERE n.id = $nodeId DELETE n', { nodeId });
      logger.info(`Deleted node ${nodeId} from KuzuDB`);
    } catch (error) {
      logger.error(error, `Failed to delete node ${nodeId} from KuzuDB`);
      throw error;
    }
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Deleted edge ${edgeId} (not persisted)`);
      return;
    }

    try {
      await executeKuzuQuery('MATCH ()-[r:CONNECTS]->(b) WHERE r.edge_id = $edgeId DELETE r', { edgeId });
      logger.info(`Deleted edge ${edgeId} from KuzuDB`);
    } catch (error) {
      logger.error(error, `Failed to delete edge ${edgeId} from KuzuDB`);
      throw error;
    }
  }

  async clearWorkspaceGraph(workspaceId: string): Promise<void> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn(`KuzuDB not available: Cleared graph for workspace ${workspaceId} (not persisted)`);
      return;
    }

    try {
      await executeKuzuQuery('MATCH (n) WHERE n.workspace_id = $workspace_id DETACH DELETE n', { workspace_id: workspaceId });
      logger.info(`Cleared all graph data for workspace ${workspaceId}`);
    } catch (error) {
      logger.error(error, `Failed to clear graph for workspace ${workspaceId}`);
      throw error;
    }
  }

  // Get ALL entities without permission filtering - for debugging
  async getAllEntities(): Promise<{ nodes: any[], relations: any[] }> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn('KuzuDB not available');
      return { nodes: [], relations: [] };
    }

    try {
      const allNodes: any[] = [];
      
      // Query each entity type separately from the schema
      const entityTypes = ['Person', 'Team', 'Organization', 'Project', 'Repository', 'Branch', 'CodeChangeRequest', 'Issue', 'Event', 'Topic'];
      
      for (const entityType of entityTypes) {
        try {
          const entityQuery = `MATCH (n:${entityType}) RETURN n, "${entityType}" as nodeType LIMIT 100`;
          const entityResult = await executeKuzuQuery(entityQuery, {});
          
          if (entityResult.rows && entityResult.rows.length > 0) {
            // Add entity type to each node - handle different response structures
            const nodesWithType = entityResult.rows.map((row: any) => {
              const nodeData = row.n || row[0] || row;
              const actualType = row.nodeType || entityType;
              return {
                ...nodeData,
                _actualKuzuType: actualType,
                _label: actualType
              };
            });
            allNodes.push(...nodesWithType);
          }
        } catch (entityError) {
          logger.warn(`Failed to query ${entityType}: ${entityError}`);
        }
      }

      // Get all relations
      const relationsQuery = `MATCH (a)-[r]->(b) RETURN r, a.name as source, b.name as target`;
      const relationsResult = await executeKuzuQuery(relationsQuery, {});

      const relations = relationsResult.rows || [];
      
      logger.info(`Total nodes: ${allNodes.length}, Total relations: ${relations.length}`);
      
      return { nodes: allNodes, relations };
    } catch (error) {
      logger.error(error, `Failed to retrieve all entities`);
      throw error;
    }
  }

  // Fetch all nodes and relations based on permissions - query each entity type separately
  async getAllDataByPermission(permission: string): Promise<{ nodes: any[], relations: any[] }> {
    this.ensureInitialized();

    if (!kuzuAvailable) {
      logger.warn('KuzuDB not available');
      return { nodes: [], relations: [] };
    }


    try {
      // Use a single query to get all nodes with the permission filter - try with COUNT first to test
      const testQuery = `MATCH (n) WHERE '${permission}' IN n.permissions RETURN count(n) as nodeCount`;
      logger.info(`Testing count query: ${testQuery}`);
      
      let nodeResult;
      try {
        const testResult = await executeKuzuQuery(testQuery, {});
        logger.info(`Count query result: ${JSON.stringify(testResult)}`);
        
        // If count works, try the full query with limit to avoid size issues
        const nodeQuery = `MATCH (n) WHERE '${permission}' IN n.permissions RETURN n as node LIMIT 100`;
        logger.info(`Executing full node query: ${nodeQuery}`);
        nodeResult = await executeKuzuQuery(nodeQuery, {});
        logger.info(`Node query returned ${nodeResult.rows?.length || 0} results`);
      } catch (queryError) {
        logger.error(`Query failed: ${queryError}`);
        nodeResult = { rows: [] };
      }
      
      const allNodes = (nodeResult.rows || []).map((row: any) => {
        const nodeData = row.node;
        const actualType = nodeData._label || 'entity';
        
        return {
          ...nodeData,
          _actualKuzuType: actualType,
          _label: actualType
        };
      });

      // Fetch all relations with a single query
      const relationQuery = `MATCH (a)-[r]->(b) WHERE '${permission}' IN r.permissions RETURN r, a.name as source, b.name as target`;
      let relationsResult;
      try {
        relationsResult = await executeKuzuQuery(relationQuery, {});
      } catch (relationError) {
        logger.warn(`Relations query failed: ${relationError}`);
        relationsResult = { rows: [] };
      }

      const relations = relationsResult.rows || [];
      
      // Debug: Check if any nodes have permissions field and what values they contain
      if (allNodes.length > 0) {
        const nodeWithPermissions = allNodes.find((node: { permissions: string | any[]; }) => node.permissions && node.permissions.length > 0);
        if (nodeWithPermissions) {
          logger.info(`Sample permissions found: ${JSON.stringify(nodeWithPermissions.permissions)} (searching for: ${permission})`);
        } else {
          logger.warn(`No nodes have permissions field or all permissions arrays are empty`);
        }
      }
      
      logger.info(`Found ${allNodes.length} nodes and ${relations.length} relations for permission: ${permission}`);
      
      return { nodes: allNodes, relations };
    } catch (error) {
      logger.error(error, `Failed to retrieve data for permission: ${permission}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    // No cleanup needed for Python subprocess approach
    this.isInitialized = false;
    logger.info('KuzuDB connection closed');
  }
}

// Singleton instance
let kuzuGraphService: KuzuGraphService | null = null;

export const getKuzuGraphService = (): KuzuGraphService => {
  if (!kuzuGraphService) {
    kuzuGraphService = new KuzuGraphService();
  }
  return kuzuGraphService;
};

export { KuzuGraphService };
