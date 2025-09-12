import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { GraphData, GraphNode, GraphEdge, NODE_TYPE_CONFIG } from '../types/graph';

interface GraphVisualizationProps {
  graphData: GraphData;
  width?: number;
  height?: number;
  onNodeClick?: (node: GraphNode) => void;
  onEdgeClick?: (edge: GraphEdge) => void;
  onBackgroundClick?: () => void;
  className?: string;
  darkMode?: boolean;
  layoutMode?: 'hierarchy' | 'graph';
}

interface D3Node extends GraphNode {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
}

interface D3Edge extends GraphEdge {
  source: D3Node;
  target: D3Node;
}

export const GraphVisualization: React.FC<GraphVisualizationProps> = ({
  graphData,
  width = 800,
  height = 600,
  onNodeClick,
  onEdgeClick,
  onBackgroundClick,
  className = '',
  darkMode = false,
  layoutMode = 'hierarchy'
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<D3Node, D3Edge> | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const prepareData = useCallback((): { nodes: D3Node[], edges: D3Edge[] } => {
    const nodeMap = new Map<string, D3Node>();
    
    // Create nodes with initial positions
    const nodes: D3Node[] = graphData.nodes.map(node => {
      const d3Node: D3Node = {
        ...node,
        x: node.x || Math.random() * width,
        y: node.y || Math.random() * height
      };
      nodeMap.set(node.id, d3Node);
      return d3Node;
    });

    // Create edges with source/target references
    const edges: D3Edge[] = graphData.edges
      .map(edge => {
        const source = nodeMap.get(edge.from);
        const target = nodeMap.get(edge.to);
        
        if (source && target) {
          return {
            ...edge,
            source,
            target
          };
        }
        return null;
      })
      .filter((edge): edge is D3Edge => edge !== null);

    return { nodes, edges };
  }, [graphData, width, height]);

  const createSimulation = useCallback((nodes: D3Node[], edges: D3Edge[]) => {
    // Custom hierarchical positioning force based on node types
    const hierarchicalForce = () => {
      // Define unique levels for each node type (13 distinct levels)
      const nodeLevels: Record<string, number> = {
        seed: 0.10,        // Top level - seeds
        concept: 0.17,     // Second level - concepts
        entity: 0.24,      // Third level - entities
        person: 0.31,      // Fourth level - people
        company: 0.38,     // Fifth level - companies
        project: 0.45,     // Sixth level - projects
        tool: 0.52,        // Seventh level - tools
        event: 0.59,       // Eighth level - events
        document: 0.66,    // Ninth level - documents
        folder: 0.73,      // Tenth level - folders
        file: 0.80,        // Eleventh level - files
        collection: 0.87,  // Twelfth level - collections
        relation: 0.94     // Bottom level - relations
      };

      nodes.forEach((node: D3Node) => {
        if (node.y !== undefined) {
          // Get the target level for this node type (as percentage of height)
          const levelPercentage = nodeLevels[node.type] || 0.5; // Default to middle if type not found
          const targetY = height * levelPercentage;
          
          // Apply gentle force towards target Y position
          const dy = targetY - node.y;
          node.vy = (node.vy || 0) + dy * 0.03; // Slightly stronger force for better level separation
        }
      });
    };

    const simulation = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Edge>(edges)
        .id(d => d.id)
        .distance(layoutMode === 'hierarchy' ? 200 : 120) // Closer links for graph mode
        .strength(layoutMode === 'hierarchy' ? 0.08 : 0.3) // Stronger links for graph mode
      )
      .force('charge', d3.forceManyBody()
        .strength(layoutMode === 'hierarchy' ? -1500 : -800) // Less repulsion for graph mode
        .distanceMin(layoutMode === 'hierarchy' ? 40 : 30)
        .distanceMax(layoutMode === 'hierarchy' ? 500 : 300)
      )
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide()
        .radius((d: any) => NODE_TYPE_CONFIG[(d as D3Node).type].size + (layoutMode === 'hierarchy' ? 25 : 15))
        .strength(1.0)
        .iterations(layoutMode === 'hierarchy' ? 3 : 2)
      );

    // Only add hierarchical force in hierarchy mode
    if (layoutMode === 'hierarchy') {
      simulation.force('hierarchy', hierarchicalForce);
    }

    return simulation;
  }, [width, height, layoutMode]);

  const renderGraph = useCallback(() => {
    if (!svgRef.current) return;

    const svg = select(svgRef.current);
    const { nodes, edges } = prepareData();

    // Clear previous content
    svg.selectAll('*').remove();

    // Create defs for arrow markers
    const defs = svg.append('defs');
    
    // Create arrow marker for light mode
    defs.append('marker')
      .attr('id', 'arrowhead-light')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#94a3b8');

    // Create arrow marker for dark mode
    defs.append('marker')
      .attr('id', 'arrowhead-dark')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#64748b');

    // Create hover arrow marker
    defs.append('marker')
      .attr('id', 'arrowhead-hover')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#ef4444');

    // Create container group for zooming
    const container = svg.append('g').attr('class', 'graph-container');

    // Setup zoom behavior
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });

    svg.call(zoomBehavior);

    // Add background click handler
    svg.on('click', (event) => {
      if (event.target === svg.node()) {
        setSelectedNode(null);
        onBackgroundClick?.();
      }
    });

    // Create edges with arrowheads
    const linkElements = container
      .selectAll('.edge')
      .data(edges)
      .enter()
      .append('line')
      .attr('class', 'edge')
      .attr('stroke', darkMode ? '#64748b' : '#94a3b8')
      .attr('stroke-width', 2)
      .attr('marker-end', darkMode ? 'url(#arrowhead-dark)' : 'url(#arrowhead-light)')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        onEdgeClick?.(d);
      })
      .on('mouseenter', function() {
        select(this)
          .attr('stroke', '#ef4444')
          .attr('stroke-width', 4)
          .attr('marker-end', 'url(#arrowhead-hover)');
      })
      .on('mouseleave', function() {
        select(this)
          .attr('stroke', darkMode ? '#64748b' : '#94a3b8')
          .attr('stroke-width', 2)
          .attr('marker-end', darkMode ? 'url(#arrowhead-dark)' : 'url(#arrowhead-light)');
      });

    // Create node groups
    const nodeElements = container
      .selectAll('.node')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', 'node')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        setSelectedNode(d.id);
        onNodeClick?.(d);
      })
      .call(
        drag<SVGGElement, D3Node>()
          .on('start', (event: any, d: D3Node) => {
            if (!event.active && simulationRef.current) {
              simulationRef.current.alphaTarget(0.3).restart();
            }
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event: any, d: D3Node) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event: any, d: D3Node) => {
            if (!event.active && simulationRef.current) {
              simulationRef.current.alphaTarget(0);
            }
            d.fx = null;
            d.fy = null;
          })
      );

    // Add circles to node groups
    nodeElements
      .append('circle')
      .attr('r', d => NODE_TYPE_CONFIG[d.type].size)
      .attr('fill', d => selectedNode === d.id ? '#ef4444' : NODE_TYPE_CONFIG[d.type].color)
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);

    // Add labels to node groups
    nodeElements
      .append('text')
      .text(d => d.name)
      .attr('dy', d => NODE_TYPE_CONFIG[d.type].size + 15)
      .attr('text-anchor', 'middle')
      .attr('font-size', '12px')
      .attr('font-family', 'Inter, sans-serif')
      .attr('fill', darkMode ? '#f3f4f6' : '#374151')
      .attr('pointer-events', 'none');


    // Create and start simulation
    const simulation = createSimulation(nodes, edges);
    simulationRef.current = simulation;

    simulation.on('tick', () => {
      linkElements
        .each(function(d) {
          const sourceNode = d.source;
          const targetNode = d.target;
          
          if (!sourceNode.x || !sourceNode.y || !targetNode.x || !targetNode.y) return;
          
          // Calculate the edge endpoints, accounting for node radius
          const sourceRadius = NODE_TYPE_CONFIG[sourceNode.type].size;
          const targetRadius = NODE_TYPE_CONFIG[targetNode.type].size;
          
          // Calculate angle between nodes
          const dx = targetNode.x - sourceNode.x;
          const dy = targetNode.y - sourceNode.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance === 0) return;
          
          // Calculate start and end points, offset by node radius
          const unitX = dx / distance;
          const unitY = dy / distance;
          
          const startX = sourceNode.x + unitX * sourceRadius;
          const startY = sourceNode.y + unitY * sourceRadius;
          const endX = targetNode.x - unitX * (targetRadius + 8); // Extra offset for arrow
          const endY = targetNode.y - unitY * (targetRadius + 8);
          
          select(this)
            .attr('x1', startX)
            .attr('y1', startY)
            .attr('x2', endX)
            .attr('y2', endY);
        });

      nodeElements
        .attr('transform', d => `translate(${d.x || 0}, ${d.y || 0})`);
    });

    // Store zoom behavior for external access
    (svg.node() as any)._zoomBehavior = zoomBehavior;

  }, [
    prepareData, 
    createSimulation, 
    selectedNode, 
    onNodeClick, 
    onEdgeClick, 
    onBackgroundClick,
    darkMode
  ]);

  // Reset zoom function
  const resetZoom = useCallback(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const zoomBehavior = (svg.node() as any)?._zoomBehavior;
    if (zoomBehavior) {
      svg.transition().duration(750).call(zoomBehavior.transform, zoomIdentity);
    }
  }, []);

  // Restart layout function
  const restartLayout = useCallback(() => {
    if (simulationRef.current) {
      simulationRef.current.alpha(1).restart();
    }
  }, []);

  useEffect(() => {
    renderGraph();

    return () => {
      if (simulationRef.current) {
        simulationRef.current.stop();
      }
    };
  }, [renderGraph]);

  // Restart simulation when dimensions change
  useEffect(() => {
    if (simulationRef.current) {
      simulationRef.current.alpha(0.3).restart();
    }
  }, [width, height]);

  // Update node selection styling
  useEffect(() => {
    if (!svgRef.current) return;
    
    const svg = select(svgRef.current);
    svg.selectAll<SVGCircleElement, D3Node>('.node circle')
      .attr('fill', (d) => 
        selectedNode === d.id ? '#ef4444' : NODE_TYPE_CONFIG[d.type].color
      )
      .attr('r', (d) => 
        selectedNode === d.id 
          ? NODE_TYPE_CONFIG[d.type].size * 1.3 
          : NODE_TYPE_CONFIG[d.type].size
      );
  }, [selectedNode]);

  return (
    <div className={`relative ${className}`}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
        style={{ backgroundColor: darkMode ? '#1f2937' : '#ffffff' }}
      />
      
      {/* Graph controls overlay */}
      <div className="absolute top-4 right-4 flex flex-col gap-2">
        <button
          onClick={resetZoom}
          className="p-2 bg-white dark:bg-[#2d2d2d] border border-gray-200 dark:border-gray-600 rounded-lg shadow-sm hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors"
          title="Reset zoom to fit"
        >
          🎯
        </button>
        <button
          onClick={restartLayout}
          className="p-2 bg-white dark:bg-[#2d2d2d] border border-gray-200 dark:border-gray-600 rounded-lg shadow-sm hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors"
          title="Re-layout graph nodes"
        >
          🔄
        </button>
      </div>

      {/* Node count indicator */}
      <div className="absolute bottom-4 left-4 bg-white dark:bg-[#2d2d2d] border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-600 dark:text-gray-300 shadow-sm">
        <span className="font-mono text-xs">
          {graphData.nodes.length} NODES • {graphData.edges.length} EDGES
        </span>
      </div>
    </div>
  );
};
