import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getLogger } from '@/logger';
import { Subsystem } from '@/types';

const logger = getLogger(Subsystem.Db);

// KuzuDB database path
const KUZU_DB_PATH = process.env.KUZU_DB_PATH || path.join(process.cwd(), 'data', 'knowledge_graph.kuzu');

// Ensure the database directory exists
const dbDir = path.dirname(KUZU_DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Python executable path
const PYTHON_PATH = '/usr/bin/python3';

// Helper function to execute Python kuzu commands
async function executeKuzuCommand(command: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const pythonScript = `
import kuzu
import json
import sys

db_path = "${KUZU_DB_PATH}"
db = kuzu.Database(db_path)
conn = kuzu.Connection(db)

try:
    command = "${command}"
    params = ${JSON.stringify(params)}
    
    if command == "create_schema":
        # Create Node table
        conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS GraphNode(
                id STRING,
                workspace_id STRING,
                name STRING,
                description STRING,
                node_type STRING,
                position_x DOUBLE,
                position_y DOUBLE,
                size INT64,
                color STRING,
                metadata STRING,
                created_by STRING,
                created_at TIMESTAMP,
                updated_at TIMESTAMP,
                source STRING,
                PRIMARY KEY (id)
            )
        """)
        
        # Create Relationship table
        conn.execute("""
            CREATE REL TABLE IF NOT EXISTS CONNECTS(
                FROM GraphNode TO GraphNode,
                edge_id STRING,
                workspace_id STRING,
                relationship_type STRING,
                weight DOUBLE,
                metadata STRING,
                created_by STRING,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            )
        """)
        print(json.dumps({"success": True}))
        
    elif command == "create_node":
        # Convert timestamps to proper format for KuzuDB
        from datetime import datetime
        
        # Parse and convert timestamps
        created_at = datetime.fromisoformat(params['created_at'].replace('Z', '+00:00'))
        updated_at = datetime.fromisoformat(params['updated_at'].replace('Z', '+00:00'))
        
        query = """
            CREATE (n:GraphNode {
                id: $id,
                workspace_id: $workspace_id,
                name: $name,
                description: $description,
                node_type: $node_type,
                position_x: $position_x,
                position_y: $position_y,
                size: $size,
                color: $color,
                metadata: $metadata,
                created_by: $created_by,
                created_at: $created_at,
                updated_at: $updated_at,
                source: $source
            })
        """
        
        # Update params with converted timestamps
        params_with_timestamps = params.copy()
        params_with_timestamps['created_at'] = created_at
        params_with_timestamps['updated_at'] = updated_at
        
        conn.execute(query, params_with_timestamps)
        print(json.dumps({"success": True, "node": params}))
        
    elif command == "create_edge":
        # Convert timestamps to proper format for KuzuDB
        from datetime import datetime
        
        # Parse and convert timestamps
        created_at = datetime.fromisoformat(params['created_at'].replace('Z', '+00:00'))
        updated_at = datetime.fromisoformat(params['updated_at'].replace('Z', '+00:00'))
        
        query = """
            MATCH (a:GraphNode {id: $from_node_id}), (b:GraphNode {id: $to_node_id})
            CREATE (a)-[r:CONNECTS {
                edge_id: $edge_id,
                workspace_id: $workspace_id,
                relationship_type: $relationship_type,
                weight: $weight,
                metadata: $metadata,
                created_by: $created_by,
                created_at: $created_at,
                updated_at: $updated_at
            }]->(b)
        """
        
        # Update params with converted timestamps
        params_with_timestamps = params.copy()
        params_with_timestamps['created_at'] = created_at
        params_with_timestamps['updated_at'] = updated_at
        
        conn.execute(query, params_with_timestamps)
        print(json.dumps({"success": True, "edge": params}))
        
    elif command == "get_workspace_graph":
        # Get nodes
        nodes_query = """
            MATCH (n:GraphNode)
            WHERE n.workspace_id = $workspace_id
            RETURN n.id as id, n.workspace_id as workspace_id, n.name as name, 
                   n.description as description, n.node_type as node_type,
                   n.position_x as position_x, n.position_y as position_y,
                   n.size as size, n.color as color, n.metadata as metadata,
                   n.created_by as created_by, n.created_at as created_at,
                   n.updated_at as updated_at, n.source as source
        """
        nodes_result = conn.execute(nodes_query, params)
        nodes = []
        while nodes_result.has_next():
            row = nodes_result.get_next()
            nodes.append({
                "id": row[0],
                "workspace_id": row[1],
                "name": row[2],
                "description": row[3],
                "node_type": row[4],
                "position_x": row[5],
                "position_y": row[6],
                "size": row[7],
                "color": row[8],
                "metadata": row[9],
                "created_by": row[10],
                "created_at": row[11].isoformat() if row[11] else None,
                "updated_at": row[12].isoformat() if row[12] else None,
                "source": row[13]
            })
        
        # Get edges
        edges_query = """
            MATCH (a:GraphNode)-[r:CONNECTS]->(b:GraphNode)
            WHERE r.workspace_id = $workspace_id
            RETURN r.edge_id as id, r.workspace_id as workspace_id,
                   a.id as from_node_id, b.id as to_node_id,
                   r.relationship_type as relationship_type, r.weight as weight,
                   r.metadata as metadata, r.created_by as created_by,
                   r.created_at as created_at, r.updated_at as updated_at
        """
        edges_result = conn.execute(edges_query, params)
        edges = []
        while edges_result.has_next():
            row = edges_result.get_next()
            edges.append({
                "id": row[0],
                "workspace_id": row[1],
                "from_node_id": row[2],
                "to_node_id": row[3],
                "relationship_type": row[4],
                "weight": row[5],
                "metadata": row[6],
                "created_by": row[7],
                "created_at": row[8].isoformat() if row[8] else None,
                "updated_at": row[9].isoformat() if row[9] else None
            })
        
        print(json.dumps({"success": True, "nodes": nodes, "edges": edges}))
        
    elif command == "delete_node":
        # Delete edges first
        conn.execute("""
            MATCH (a:GraphNode)-[r:CONNECTS]-(b:GraphNode)
            WHERE a.id = $nodeId OR b.id = $nodeId
            DELETE r
        """, params)
        
        # Delete node
        conn.execute("""
            MATCH (n:GraphNode {id: $nodeId})
            DELETE n
        """, params)
        
        print(json.dumps({"success": True}))
        
    elif command == "delete_edge":
        conn.execute("""
            MATCH ()-[r:CONNECTS {edge_id: $edgeId}]->()
            DELETE r
        """, params)
        print(json.dumps({"success": True}))
        
    elif command == "clear_workspace":
        # Delete edges
        conn.execute("""
            MATCH ()-[r:CONNECTS]->()
            WHERE r.workspace_id = $workspace_id
            DELETE r
        """, params)
        
        # Delete nodes
        conn.execute("""
            MATCH (n:GraphNode)
            WHERE n.workspace_id = $workspace_id
            DELETE n
        """, params)
        
        print(json.dumps({"success": True}))
        
    else:
        print(json.dumps({"error": "Unknown command"}))
        
except Exception as e:
    print(json.dumps({"error": str(e)}))
finally:
    conn.close()
    db.close()
`;

    const python = spawn(PYTHON_PATH, ['-c', pythonScript]);
    let output = '';
    let error = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      error += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process failed with code ${code}: ${error}`));
        return;
      }

      try {
        const result = JSON.parse(output.trim());
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${output}`));
      }
    });
  });
}

// Test kuzu availability on startup
let kuzuAvailable = false;
(async () => {
  try {
    await executeKuzuCommand('create_schema');
    kuzuAvailable = true;
    logger.info('KuzuDB (Python) successfully initialized');
  } catch (error) {
    logger.error(error, 'Failed to initialize KuzuDB (Python)');
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

      await executeKuzuCommand('create_node', params);
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

      await executeKuzuCommand('create_edge', params);
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
      const result = await executeKuzuCommand('get_workspace_graph', { workspace_id: workspaceId });
      
      const nodes: KuzuGraphNode[] = result.nodes.map((node: any) => ({
        ...node,
        metadata: JSON.parse(node.metadata || '{}'),
      }));

      const edges: KuzuGraphEdge[] = result.edges.map((edge: any) => ({
        ...edge,
        metadata: JSON.parse(edge.metadata || '{}'),
      }));

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
      await executeKuzuCommand('delete_node', { nodeId });
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
      await executeKuzuCommand('delete_edge', { edgeId });
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
      await executeKuzuCommand('clear_workspace', { workspace_id: workspaceId });
      logger.info(`Cleared all graph data for workspace ${workspaceId}`);
    } catch (error) {
      logger.error(error, `Failed to clear graph for workspace ${workspaceId}`);
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
