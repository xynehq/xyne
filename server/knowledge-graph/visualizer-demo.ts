#!/usr/bin/env bun
/**
 * Knowledge Graph Visualizer Demo
 *
 * This script demonstrates how to use the visualization utilities
 * to convert knowledge graph data into formats for different visualization libraries.
 */

import { KnowledgeGraphVisualizer } from "./visualization"
import { createKnowledgeGraphService } from "./pipeline"
import sampleData from "./sample-data.json"

// Mock clients (same as in demo.ts)
class MockLLMClient {
  async complete({
    messages,
  }: { messages: Array<{ role: string; content: string }> }) {
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: sampleData.knowledge_graph_example.extracted_entities,
              relationships:
                sampleData.knowledge_graph_example.extracted_relationships,
            }),
          },
        },
      ],
    }
  }
}

class MockVespaClient {
  private entities: any[] = []
  private relationships: any[] = []

  async feed(documents: any[]) {
    for (const doc of documents) {
      if (doc.put.includes("kg_entity")) {
        this.entities.push(doc.fields)
      } else if (doc.put.includes("kg_relationship")) {
        this.relationships.push(doc.fields)
      }
    }
    return { errors: [] }
  }

  async search({ yql, hits = 10 }: { yql: string; hits?: number }) {
    let results: any[] = []
    if (yql.includes("kg_entity")) {
      results = this.entities.slice(0, hits)
    } else if (yql.includes("kg_relationship")) {
      results = this.relationships.slice(0, hits)
    }
    return {
      root: {
        fields: { totalCount: results.length },
        children: results.map((fields) => ({ fields })),
      },
    }
  }
}

async function runVisualizationDemo() {
  console.log("🎨 Starting Knowledge Graph Visualization Demo\n")

  // 1. Set up the knowledge graph service and process some data
  const llmClient = new MockLLMClient()
  const vespaClient = new MockVespaClient()
  const kgService = createKnowledgeGraphService(llmClient, vespaClient)

  // Process the sample documents
  await kgService.processMultipleDocuments(
    sampleData.knowledge_graph_example.sample_documents,
  )

  // 2. Get some knowledge graph data
  console.log("📊 Getting knowledge graph data...")
  const traversalResult = await kgService.findConnectedEntities("TechCorp", 2)

  console.log(
    `Found ${traversalResult.entities.length} entities and ${traversalResult.relationships.length} relationships\n`,
  )

  // 3. Create the visualizer
  const visualizer = new KnowledgeGraphVisualizer()

  // 4. Convert to visualization format
  console.log("🔄 Converting to visualization format...")
  const visualizationGraph =
    visualizer.convertFromTraversalResult(traversalResult)

  // 5. Generate summary report
  console.log("📋 Knowledge Graph Summary:")
  console.log("=".repeat(50))
  const report = visualizer.generateSummaryReport(visualizationGraph)
  console.log(report)

  // 6. Convert to different visualization formats
  console.log("\n🎯 Converting to different visualization formats...\n")

  // Cytoscape.js format
  console.log("📱 Cytoscape.js Format:")
  const cytoscapeData = visualizer.toCytoscapeFormat(visualizationGraph)
  console.log(`Elements: ${cytoscapeData.elements.length}`)
  console.log(
    "Sample node:",
    JSON.stringify(cytoscapeData.elements[0], null, 2),
  )
  console.log()

  // D3.js format
  console.log("📊 D3.js Format:")
  const d3Data = visualizer.toD3Format(visualizationGraph)
  console.log(`Nodes: ${d3Data.nodes.length}, Links: ${d3Data.links.length}`)
  console.log("Sample node:", JSON.stringify(d3Data.nodes[0], null, 2))
  console.log("Sample link:", JSON.stringify(d3Data.links[0], null, 2))
  console.log()

  // 7. Save visualization data to files
  console.log("💾 Saving visualization data to files...")

  // Save as JSON files for use in frontend
  const fs = await import("fs/promises")

  await fs.writeFile(
    "/Users/admin/xyne/xyne/server/knowledge-graph/viz-cytoscape.json",
    JSON.stringify(cytoscapeData, null, 2),
  )

  await fs.writeFile(
    "/Users/admin/xyne/xyne/server/knowledge-graph/viz-d3.json",
    JSON.stringify(d3Data, null, 2),
  )

  await fs.writeFile(
    "/Users/admin/xyne/xyne/server/knowledge-graph/viz-report.txt",
    report,
  )

  console.log("✅ Visualization data saved:")
  console.log("  - viz-cytoscape.json (for Cytoscape.js)")
  console.log("  - viz-d3.json (for D3.js)")
  console.log("  - viz-report.txt (summary report)")

  // 8. Show how to use with different libraries
  console.log("\n🔧 Usage Examples:")
  console.log("=".repeat(50))

  console.log("\n📱 Cytoscape.js Usage:")
  console.log(`
import cytoscape from 'cytoscape';

// Load the data
const response = await fetch('/api/knowledge-graph/cytoscape');
const data = await response.json();

// Create the graph
const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: data.elements,
  style: [
    {
      selector: 'node',
      style: {
        'background-color': 'data(style.background-color)',
        'width': 'data(style.width)',
        'height': 'data(style.height)',
        'label': 'data(label)'
      }
    },
    {
      selector: 'edge',
      style: {
        'line-color': 'data(style.line-color)',
        'target-arrow-color': 'data(style.target-arrow-color)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)'
      }
    }
  ],
  layout: { name: 'cose' }
});
`)

  console.log("\n📊 D3.js Usage:")
  console.log(`
import * as d3 from 'd3';

// Load the data
const response = await fetch('/api/knowledge-graph/d3');
const data = await response.json();

// Create force simulation
const simulation = d3.forceSimulation(data.nodes)
  .force("link", d3.forceLink(data.links).id(d => d.id))
  .force("charge", d3.forceManyBody().strength(-300))
  .force("center", d3.forceCenter(width / 2, height / 2));

// Create SVG and bind data
const svg = d3.select("#graph").append("svg");
const link = svg.selectAll("line").data(data.links).enter().append("line");
const node = svg.selectAll("circle").data(data.nodes).enter().append("circle")
  .attr("r", d => d.size / 2)
  .attr("fill", d => d.color);
`)

  console.log("\n🎉 Visualization demo completed!")
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  runVisualizationDemo().catch(console.error)
}
