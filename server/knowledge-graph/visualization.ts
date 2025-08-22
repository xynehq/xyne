/**
 * Knowledge Graph Visualization Utilities
 *
 * This file provides utilities to convert knowledge graph data
 * into formats suitable for visualization libraries like D3.js, Cytoscape, etc.
 */

import type {
  VespaEntityDocument,
  VespaRelationshipDocument,
} from "./vespa-builder"
import type { GraphTraversalResult } from "./querier"

export interface VisualizationNode {
  id: string
  label: string
  type: string
  description?: string
  size: number
  color: string
  properties: Record<string, any>
}

export interface VisualizationEdge {
  id: string
  source: string
  target: string
  label: string
  type: string
  weight: number
  color: string
  properties: Record<string, any>
}

export interface VisualizationGraph {
  nodes: VisualizationNode[]
  edges: VisualizationEdge[]
  metadata: {
    totalNodes: number
    totalEdges: number
    entityTypes: Record<string, number>
    relationshipTypes: Record<string, number>
  }
}

export class KnowledgeGraphVisualizer {
  private entityTypeColors: Record<string, string> = {
    PERSON: "#FF6B6B",
    ORGANIZATION: "#4ECDC4",
    LOCATION: "#45B7D1",
    CONCEPT: "#96CEB4",
    PRODUCT: "#FFEAA7",
    EVENT: "#DDA0DD",
    DATE: "#98D8C8",
  }

  private relationshipTypeColors: Record<string, string> = {
    works_at: "#FF8C94",
    CEO_OF: "#FF6B6B",
    acquired: "#FFD93D",
    developed: "#6BCF7F",
    specializes_in: "#4D96FF",
    advised: "#9B59B6",
    founded: "#F39C12",
    located_in: "#1ABC9C",
  }

  convertToVisualizationFormat(
    entities: VespaEntityDocument[],
    relationships: VespaRelationshipDocument[],
  ): VisualizationGraph {
    const nodes = this.convertEntities(entities, relationships)
    const edges = this.convertRelationships(relationships)

    const entityTypes = this.countEntityTypes(entities)
    const relationshipTypes = this.countRelationshipTypes(relationships)

    return {
      nodes,
      edges,
      metadata: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        entityTypes,
        relationshipTypes,
      },
    }
  }

  convertFromTraversalResult(
    traversalResult: GraphTraversalResult,
  ): VisualizationGraph {
    return this.convertToVisualizationFormat(
      traversalResult.entities,
      traversalResult.relationships,
    )
  }

  private convertEntities(
    entities: VespaEntityDocument[],
    relationships: VespaRelationshipDocument[],
  ): VisualizationNode[] {
    const entityConnectionCounts = this.calculateEntityConnections(
      entities,
      relationships,
    )

    return entities.map((entity) => {
      const connectionCount = entityConnectionCounts[entity.name] || 0
      const size = Math.max(10, Math.min(50, 10 + connectionCount * 5))

      return {
        id: entity.id,
        label: entity.name,
        type: entity.type,
        description: entity.description,
        size,
        color: this.entityTypeColors[entity.type] || "#95A5A6",
        properties: {
          ...entity.properties,
          connectionCount,
          created_at: entity.created_at,
          updated_at: entity.updated_at,
        },
      }
    })
  }

  private convertRelationships(
    relationships: VespaRelationshipDocument[],
  ): VisualizationEdge[] {
    return relationships.map((rel) => ({
      id: rel.id,
      source: this.generateEntityId(rel.source_entity, ""),
      target: this.generateEntityId(rel.target_entity, ""),
      label: rel.relationship_type.replace(/_/g, " "),
      type: rel.relationship_type,
      weight: rel.confidence,
      color: this.relationshipTypeColors[rel.relationship_type] || "#BDC3C7",
      properties: {
        ...rel.properties,
        confidence: rel.confidence,
        description: rel.description,
        created_at: rel.created_at,
      },
    }))
  }

  private calculateEntityConnections(
    entities: VespaEntityDocument[],
    relationships: VespaRelationshipDocument[],
  ): Record<string, number> {
    const connections: Record<string, number> = {}

    entities.forEach((entity) => {
      connections[entity.name] = 0
    })

    relationships.forEach((rel) => {
      connections[rel.source_entity] = (connections[rel.source_entity] || 0) + 1
      connections[rel.target_entity] = (connections[rel.target_entity] || 0) + 1
    })

    return connections
  }

  private generateEntityId(name: string, type: string): string {
    return `entity_${name.toLowerCase().replace(/\s+/g, "_")}_${type.toLowerCase()}`
  }

  private countEntityTypes(
    entities: VespaEntityDocument[],
  ): Record<string, number> {
    const counts: Record<string, number> = {}
    entities.forEach((entity) => {
      counts[entity.type] = (counts[entity.type] || 0) + 1
    })
    return counts
  }

  private countRelationshipTypes(
    relationships: VespaRelationshipDocument[],
  ): Record<string, number> {
    const counts: Record<string, number> = {}
    relationships.forEach((rel) => {
      counts[rel.relationship_type] = (counts[rel.relationship_type] || 0) + 1
    })
    return counts
  }

  // Convert to Cytoscape.js format
  toCytoscapeFormat(graph: VisualizationGraph) {
    const elements = [
      ...graph.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
          ...node.properties,
        },
        style: {
          "background-color": node.color,
          width: node.size,
          height: node.size,
          label: node.label,
        },
      })),
      ...graph.edges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          type: edge.type,
          weight: edge.weight,
          ...edge.properties,
        },
        style: {
          "line-color": edge.color,
          "target-arrow-color": edge.color,
          width: Math.max(1, edge.weight * 5),
          label: edge.label,
        },
      })),
    ]

    return { elements, ...graph.metadata }
  }

  // Convert to D3.js force layout format
  toD3Format(graph: VisualizationGraph) {
    return {
      nodes: graph.nodes,
      links: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        value: edge.weight,
        id: edge.id,
        label: edge.label,
        type: edge.type,
        color: edge.color,
        properties: edge.properties,
      })),
      ...graph.metadata,
    }
  }

  // Generate a summary report
  generateSummaryReport(graph: VisualizationGraph): string {
    const { metadata } = graph

    let report = "Knowledge Graph Summary Report\n"
    report += "=".repeat(40) + "\n\n"

    report += `Total Entities: ${metadata.totalNodes}\n`
    report += `Total Relationships: ${metadata.totalEdges}\n\n`

    report += "Entity Types:\n"
    Object.entries(metadata.entityTypes)
      .sort(([, a], [, b]) => b - a)
      .forEach(([type, count]) => {
        report += `  ${type}: ${count}\n`
      })

    report += "\nRelationship Types:\n"
    Object.entries(metadata.relationshipTypes)
      .sort(([, a], [, b]) => b - a)
      .forEach(([type, count]) => {
        report += `  ${type}: ${count}\n`
      })

    // Find most connected entities
    const sortedNodes = graph.nodes
      .sort(
        (a, b) =>
          (b.properties.connectionCount || 0) -
          (a.properties.connectionCount || 0),
      )
      .slice(0, 5)

    report += "\nMost Connected Entities:\n"
    sortedNodes.forEach((node, index) => {
      report += `  ${index + 1}. ${node.label} (${node.properties.connectionCount || 0} connections)\n`
    })

    return report
  }
}

// Example usage for different visualization libraries
export const VisualizationExamples = {
  // Cytoscape.js example
  cytoscapeExample: `
import cytoscape from 'cytoscape';
import { KnowledgeGraphVisualizer } from './visualization';

const visualizer = new KnowledgeGraphVisualizer();
const graph = visualizer.convertToVisualizationFormat(entities, relationships);
const cytoscapeData = visualizer.toCytoscapeFormat(graph);

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: cytoscapeData.elements,
  style: [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'width': 'data(size)',
        'height': 'data(size)'
      }
    },
    {
      selector: 'edge',
      style: {
        'label': 'data(label)',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle'
      }
    }
  ],
  layout: { name: 'cose' }
});
  `,

  // D3.js example
  d3Example: `
import * as d3 from 'd3';
import { KnowledgeGraphVisualizer } from './visualization';

const visualizer = new KnowledgeGraphVisualizer();
const graph = visualizer.convertToVisualizationFormat(entities, relationships);
const d3Data = visualizer.toD3Format(graph);

const simulation = d3.forceSimulation(d3Data.nodes)
  .force("link", d3.forceLink(d3Data.links).id(d => d.id))
  .force("charge", d3.forceManyBody().strength(-300))
  .force("center", d3.forceCenter(width / 2, height / 2));

const svg = d3.select("#graph").append("svg");
const link = svg.selectAll(".link").data(d3Data.links);
const node = svg.selectAll(".node").data(d3Data.nodes);

// Add visualization code...
  `,

  // React component example
  reactExample: `
import React from 'react';
import { KnowledgeGraphVisualizer } from './visualization';

function KnowledgeGraphComponent({ entities, relationships }) {
  const visualizer = new KnowledgeGraphVisualizer();
  const graph = visualizer.convertToVisualizationFormat(entities, relationships);
  
  return (
    <div className="knowledge-graph">
      <div className="graph-stats">
        <h3>Knowledge Graph</h3>
        <p>Entities: {graph.metadata.totalNodes}</p>
        <p>Relationships: {graph.metadata.totalEdges}</p>
      </div>
      
      <div className="entity-legend">
        {Object.entries(graph.metadata.entityTypes).map(([type, count]) => (
          <div key={type} className="legend-item">
            <span className="color-box" style={{ backgroundColor: visualizer.entityTypeColors[type] }}></span>
            {type}: {count}
          </div>
        ))}
      </div>
      
      <div id="graph-container">
        {/* Graph visualization goes here */}
      </div>
    </div>
  );
}
  `,
}

export default KnowledgeGraphVisualizer
