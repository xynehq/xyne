export interface GraphNode {
  id: string
  name: string
  description?: string
  type: NodeType
  metadata?: Record<string, any>
  x?: number
  y?: number
  size?: number
  color?: string
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  relationship?: string
  metadata?: Record<string, any>
  weight?: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type NodeType =
  // KuzuDB schema types
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

export interface GraphStats {
  totalNodes: number
  totalEdges: number
  nodesByType: Record<NodeType, number>
  avgConnections: number
}

export const NODE_TYPE_CONFIG: Record<
  NodeType,
  {
    icon: string
    color: string
    label: string
    size: number
  }
> = {
  // KuzuDB schema types
  Person: { icon: "👤", color: "#F4A261", label: "Person", size: 18 },
  Team: { icon: "👥", color: "#1D3557", label: "Team", size: 20 },
  Organization: {
    icon: "🏢",
    color: "#2A9D8F",
    label: "Organization",
    size: 18,
  },
  Project: { icon: "📋", color: "#E9C46A", label: "Project", size: 18 },
  Repository: { icon: "📦", color: "#8D99AE", label: "Repository", size: 18 },
  Branch: { icon: "🌿", color: "#90A955", label: "Branch", size: 16 },
  CodeChangeRequest: {
    icon: "🔄",
    color: "#F77F00",
    label: "Code Change Request",
    size: 16,
  },
  Issue: { icon: "🐛", color: "#E63946", label: "Issue", size: 16 },
  Event: { icon: "📅", color: "#F77F00", label: "Event", size: 18 },
  Topic: { icon: "🏷️", color: "#457B9D", label: "Topic", size: 18 },
  Relation: { icon: "🔗", color: "#ec4899", label: "Relation", size: 12 },
}
