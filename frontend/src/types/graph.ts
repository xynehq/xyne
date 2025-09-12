export interface GraphNode {
  id: string;
  name: string;
  description?: string;
  type: NodeType;
  metadata?: Record<string, any>;
  x?: number;
  y?: number;
  size?: number;
  color?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relationship?: string;
  metadata?: Record<string, any>;
  weight?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type NodeType = 
  | 'seed'
  | 'concept' 
  | 'person'
  | 'company'
  | 'project'
  | 'document'
  | 'event'
  | 'tool'
  | 'entity'
  | 'relation'
  | 'collection'
  | 'folder'
  | 'file';

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<NodeType, number>;
  avgConnections: number;
}

export const NODE_TYPE_CONFIG: Record<NodeType, { 
  icon: string; 
  color: string; 
  label: string;
  size: number;
}> = {
  seed: { icon: '', color: '#E63946', label: 'Seed', size: 26 },
  concept: { icon: '', color: '#457B9D', label: 'Concept', size: 22 },
  entity: { icon: '', color: '#1D3557', label: 'Entity', size: 20 },
  person: { icon: '', color: '#F4A261', label: 'Person', size: 18 },
  company: { icon: '', color: '#2A9D8F', label: 'Company', size: 18 },
  project: { icon: '', color: '#E9C46A', label: 'Project', size: 18 },
  tool: { icon: '', color: '#8D99AE', label: 'Tool', size: 18 },
  event: { icon: '', color: '#F77F00', label: 'Event', size: 18 },
  document: { icon: '', color: '#6D597A', label: 'Document', size: 16 },
  folder: { icon: '', color: '#B5838D', label: 'Folder', size: 14 },
  file: { icon: '', color: '#A8DADC', label: 'File', size: 14 },
  collection: { icon: '', color: '#90A955', label: 'Collection', size: 14 },
  relation: { icon: '', color: '#ec4899', label: 'Relation', size: 12 }
};
