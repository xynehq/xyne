import { useEffect, useRef, useState } from 'react'
import cytoscape, { Core, ElementDefinition } from 'cytoscape'
import { SearchPanel } from './SearchPanel'
import { ControlPanel } from './ControlPanel'
import { StatsPanel } from './StatsPanel'
import { RelationshipModal } from './RelationshipModal'
import { useKnowledgeGraph } from '@/hooks/useKnowledgeGraph'

export interface NodeData {
  id: string
  label: string
  type: string
  description?: string
  size: number
  group: string
}

export interface EdgeData {
  id: string
  source: string
  target: string
  label: string
  type: string
  weight?: number
}

export interface GraphData {
  nodes: NodeData[]
  edges: EdgeData[]
  metadata: {
    centerEntity: string
    depth: number
    totalNodes: number
    totalEdges: number
    entityTypes: string[]
    relationshipTypes: string[]
  }
}

const TYPE_COLORS = {
  PERSON: '#3b82f6',      // Blue
  ORGANIZATION: '#ef4444', // Red
  CONCEPT: '#10b981',     // Green
  EVENT: '#f59e0b',       // Amber
  LOCATION: '#8b5cf6',    // Purple
  default: '#6b7280'      // Gray
}

export function KnowledgeGraphVisualizer() {
  const cyRef = useRef<HTMLDivElement>(null)
  const cyInstance = useRef<Core | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<string>('')
  const [depth, setDepth] = useState(2)
  const [layout, setLayout] = useState('cose')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedRelationship, setSelectedRelationship] = useState<any>(null)
  const [showRelationshipModal, setShowRelationshipModal] = useState(false)
  
  const {
    data: graphData,
    isLoading,
    error,
    searchEntities,
    getEntityGraph,
    getOverviewGraph,
    getRelationshipDetails
  } = useKnowledgeGraph()

  // Load overview graph on mount
  useEffect(() => {
    getOverviewGraph(25, 3) // Load top 25 entities with at least 3 connections
  }, [])

  // Initialize Cytoscape
  useEffect(() => {
    if (!cyRef.current || cyInstance.current) return

    cyInstance.current = cytoscape({
      container: cyRef.current,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'label': 'data(label)',
            'width': 'mapData(size, 1, 50, 30, 80)',
            'height': 'mapData(size, 1, 50, 30, 80)',
            'font-size': '14px',
            'text-valign': 'center',
            'text-halign': 'center',
            'color': '#fff',
            'text-outline-width': 1,
            'text-outline-color': '#000',
            'border-width': 3,
            'border-color': '#fff',
            'text-wrap': 'ellipsis',
            'text-max-width': '100px',
            'z-index': 10
          }
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 5,
            'border-color': '#3b82f6',
            'z-index': 20
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 3,
            'line-color': '#64748b',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': '11px',
            'color': '#374151',
            'text-rotation': 'none',
            'text-background-color': 'rgba(255, 255, 255, 0.8)',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
            'text-border-width': 1,
            'text-border-color': '#d1d5db',
            'source-distance-from-node': 8,
            'target-distance-from-node': 8,
            'z-index': 5
          }
        },
        {
          selector: 'edge:selected',
          style: {
            'width': 4,
            'line-color': '#3b82f6',
            'target-arrow-color': '#3b82f6',
            'z-index': 15
          }
        },
        {
          selector: 'node[type="PERSON"]',
          style: {
            'shape': 'ellipse'
          }
        },
        {
          selector: 'node[type="ORGANIZATION"]',
          style: {
            'shape': 'rectangle'
          }
        },
        {
          selector: 'node[type="CONCEPT"]',
          style: {
            'shape': 'diamond'
          }
        },
        {
          selector: 'node[type="EVENT"]',
          style: {
            'shape': 'triangle'
          }
        },
        {
          selector: 'node[type="LOCATION"]',
          style: {
            'shape': 'star'
          }
        }
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 2000,
        idealEdgeLength: 150,
        nodeOverlap: 50,
        refresh: 10,
        fit: true,
        padding: 50,
        randomize: false,
        componentSpacing: 200,
        nodeRepulsion: function() { return 8000000; },
        edgeElasticity: function() { return 100; },
        nestingFactor: 1.2,
        gravity: 0.8,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      }
    })

    // Add event listeners
    cyInstance.current.on('tap', 'node', (evt) => {
      const node = evt.target
      const nodeData = node.data()
      console.log('Node clicked:', nodeData)
      setSelectedEntity(nodeData.id)
    })

    cyInstance.current.on('tap', 'edge', (evt) => {
      const edge = evt.target
      const edgeData = edge.data()
      console.log('Edge clicked:', edgeData)
      handleRelationshipClick(edgeData)
    })

    // Cleanup
    return () => {
      if (cyInstance.current) {
        cyInstance.current.destroy()
        cyInstance.current = null
      }
    }
  }, [])

  // Update graph when data changes
  useEffect(() => {
    if (!cyInstance.current || !graphData) return

    const cy = cyInstance.current

    // Prepare nodes
    const nodes: ElementDefinition[] = graphData.nodes.map((node: NodeData) => ({
      data: {
        id: node.id,
        label: node.label,
        type: node.type,
        description: node.description,
        size: Math.max(1, Math.min(50, node.size || 10)),
        color: TYPE_COLORS[node.type as keyof typeof TYPE_COLORS] || TYPE_COLORS.default
      }
    }))

    // Prepare edges with validation
    const nodeIds = new Set(nodes.map(n => n.data!.id))
    const edges: ElementDefinition[] = graphData.edges
      .filter((edge: EdgeData) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge: EdgeData) => ({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label || edge.type,
          type: edge.type
        }
      }))

    // Update graph
    cy.elements().remove()
    cy.add([...nodes, ...edges])

    // Apply layout based on graph size and type
    let layoutConfig: any = {
      name: layout,
      animate: true,
      animationDuration: 1500,
      fit: true,
      padding: 50,
      stop: () => {
        // After layout, adjust view
        setTimeout(() => {
          cy.fit()
          cy.center()
        }, 100)
      }
    }

    // Customize layout based on graph size
    if (nodes.length > 50) {
      // For large graphs, use more spacing
      layoutConfig = {
        ...layoutConfig,
        name: 'cose',
        idealEdgeLength: 200,
        nodeOverlap: 100,
        componentSpacing: 300,
        animationDuration: 2500
      }
    } else if (nodes.length > 20) {
      // Medium graphs
      layoutConfig = {
        ...layoutConfig,
        name: 'cose',
        idealEdgeLength: 150,
        nodeOverlap: 75,
        componentSpacing: 200
      }
    } else {
      // Small graphs - use more compact layout
      layoutConfig = {
        ...layoutConfig,
        name: layout === 'cose' ? 'cose' : layout,
        idealEdgeLength: 120,
        nodeOverlap: 50,
        componentSpacing: 150
      }
    }

    cy.layout(layoutConfig).run()

  }, [graphData, layout])

  const handleSearch = async (query: string) => {
    setSearchQuery(query)
    if (query.trim()) {
      await searchEntities(query)
    }
  }

  const handleEntitySelect = async (entityName: string) => {
    setSelectedEntity(entityName)
    await getEntityGraph(entityName, depth)
  }

  const handleRelationshipClick = async (edgeData: any) => {
    console.log('Relationship clicked:', edgeData)
    
    // Get detailed information about this relationship
    try {
      const relationshipDetails = await getRelationshipDetails(
        edgeData.source, 
        edgeData.target, 
        edgeData.type
      )
      
      setSelectedRelationship({
        ...edgeData,
        details: relationshipDetails
      })
      setShowRelationshipModal(true)
    } catch (error) {
      console.error('Failed to fetch relationship details:', error)
      // Show basic relationship info even if details fail
      setSelectedRelationship(edgeData)
      setShowRelationshipModal(true)
    }
  }

  const handleShowOverview = async () => {
    setSelectedEntity('')
    await getOverviewGraph(25, 3)
  }

  const handleLayoutChange = (newLayout: string) => {
    setLayout(newLayout)
  }

  const handleDepthChange = (newDepth: number) => {
    setDepth(newDepth)
    if (selectedEntity) {
      getEntityGraph(selectedEntity, newDepth)
    }
  }

  const handleFitView = () => {
    if (cyInstance.current) {
      cyInstance.current.fit()
    }
  }

  const handleExport = () => {
    if (cyInstance.current) {
      const png = cyInstance.current.png({
        output: 'blob',
        bg: 'white',
        full: true,
        scale: 2
      })
      
      const link = document.createElement('a')
      link.download = `knowledge-graph-${selectedEntity || 'export'}.png`
      link.href = URL.createObjectURL(png as Blob)
      link.click()
    }
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <div className="flex-1 grid grid-cols-12 gap-6 p-6">
        {/* Sidebar */}
        <div className="col-span-3 space-y-6">
          <SearchPanel
            searchQuery={searchQuery}
            onSearch={handleSearch}
            onEntitySelect={handleEntitySelect}
            isLoading={isLoading}
          />
          
          <ControlPanel
            depth={depth}
            layout={layout}
            onDepthChange={handleDepthChange}
            onLayoutChange={handleLayoutChange}
            onFitView={handleFitView}
            onExport={handleExport}
            onShowOverview={handleShowOverview}
          />
          
          <StatsPanel
            graphData={graphData}
            selectedEntity={selectedEntity}
          />
        </div>

        {/* Main Graph Area */}
        <div className="col-span-9">
          <div className="bg-white rounded-lg shadow-sm h-full min-h-[700px]">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">
                Knowledge Graph Visualization
              </h2>
              {selectedEntity ? (
                <p className="text-sm text-gray-600 mt-1">
                  Centered on: <span className="font-medium">{selectedEntity}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-600 mt-1">
                  Showing overview of most connected entities
                </p>
              )}
            </div>
            
            <div className="relative h-full">
              <div
                ref={cyRef}
                className="absolute inset-4 border-2 border-gray-200 rounded bg-white"
                style={{ minHeight: '600px' }}
              />
              
              {isLoading && (
                <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2"></div>
                    <div className="text-gray-600">Loading graph...</div>
                  </div>
                </div>
              )}
              
              {error && (
                <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center">
                  <div className="text-center">
                    <div className="text-red-600 mb-2">⚠️</div>
                    <div className="text-gray-600">Failed to load graph</div>
                    <div className="text-sm text-gray-500 mt-1">{error.message}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Relationship Modal */}
      <RelationshipModal
        isOpen={showRelationshipModal}
        onClose={() => setShowRelationshipModal(false)}
        relationship={selectedRelationship}
        onEntitySelect={handleEntitySelect}
      />
    </div>
  )
}
