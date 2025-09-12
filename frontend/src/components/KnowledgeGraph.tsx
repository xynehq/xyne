import React, { useState, useCallback, useEffect } from 'react';
import { GraphVisualization } from './GraphVisualization';
import { AddNodeForm } from './AddNodeForm';
import { AddEdgeForm } from './AddEdgeForm';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { GraphData, GraphNode, GraphEdge, NODE_TYPE_CONFIG, NodeType } from '../types/graph';
import { authFetch } from '../utils/authFetch';
import { useTheme } from './ThemeContext';

export const KnowledgeGraph: React.FC = () => {
  const { theme } = useTheme();
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [showAddNode, setShowAddNode] = useState(false);
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [filterType, setFilterType] = useState<NodeType | 'all'>('all');
  const [layoutMode, setLayoutMode] = useState<'hierarchy' | 'graph'>('hierarchy');

  // Calculate responsive dimensions
  const calculateDimensions = useCallback(() => {
    const sidebarWidth = 208; // KG sidebar width
    const xyneSidebarWidth = 52; // Main Xyne sidebar width
    const leftPadding = 12; // pl-3 = 12px
    const rightPadding = 24; // pr-6 = 24px
    const headerHeight = 160; // Approximate header + padding height
    
    const availableWidth = window.innerWidth - sidebarWidth - xyneSidebarWidth - leftPadding - rightPadding;
    const availableHeight = window.innerHeight - headerHeight;
    
    setDimensions({
      width: Math.max(400, availableWidth), // Minimum width of 400px
      height: Math.max(300, availableHeight) // Minimum height of 300px
    });
  }, []);

  // Handle window resize
  useEffect(() => {
    calculateDimensions();
    
    const handleResize = () => {
      calculateDimensions();
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [calculateDimensions]);

  // Fetch graph data from API
  useEffect(() => {
    const fetchGraphData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await authFetch('/api/v1/graph/data');
        
        if (response.status === 401) {
          setError('Authentication failed. Please refresh the page and log in again.');
          setGraphData({
            nodes: [
              {
                id: 'auth_error',
                name: 'Authentication Required',
                description: 'Please refresh the page and log in again to access your knowledge graph.',
                type: 'seed',
                metadata: { created: new Date().toISOString(), isAuthError: true }
              }
            ],
            edges: []
          });
          return;
        }
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`Server error (${response.status}): ${errorText}`);
        }
        
        const data: GraphData = await response.json();
        setGraphData(data);
      } catch (err) {
        console.error('Error fetching graph data:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to load graph data';
        setError(errorMessage);
        
        // Set fallback sample data if there's an error
        setGraphData({
          nodes: [
            {
              id: 'fallback_node',
              name: 'Knowledge Graph Unavailable',
              description: 'Unable to connect to the backend server. Please ensure you are logged in and the server is running.',
              type: 'seed',
              metadata: { 
                created: new Date().toISOString(),
                isError: true,
                error: errorMessage
              }
            }
          ],
          edges: []
        });
      } finally {
        setLoading(false);
      }
    };

    fetchGraphData();
  }, []);

  const refreshGraph = useCallback(async () => {
    const fetchGraphData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await authFetch('/api/v1/graph/data');
        if (!response.ok) {
          throw new Error('Failed to fetch graph data');
        }
        
        const data: GraphData = await response.json();
        setGraphData(data);
      } catch (err) {
        console.error('Error fetching graph data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load graph data');
      } finally {
        setLoading(false);
      }
    };

    await fetchGraphData();
  }, []);

  // Filter data based on selected type
  const filteredData = {
    nodes: filterType === 'all' 
      ? graphData.nodes 
      : graphData.nodes.filter(node => node.type === filterType),
    edges: filterType === 'all'
      ? graphData.edges
      : graphData.edges.filter(edge => {
          const sourceNode = graphData.nodes.find(n => n.id === edge.from);
          const targetNode = graphData.nodes.find(n => n.id === edge.to);
          return sourceNode?.type === filterType || targetNode?.type === filterType;
        })
  };

  const handleNodeAdd = useCallback(async (nodeData: Omit<GraphNode, 'id'>) => {
    try {
      const response = await authFetch('/api/v1/graph/nodes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nodeData),
      });

      if (!response.ok) {
        throw new Error('Failed to create node');
      }

      const createdNode = await response.json();
      
      setGraphData(prev => ({
        ...prev,
        nodes: [...prev.nodes, createdNode]
      }));

      setShowAddNode(false);
    } catch (error) {
      console.error('Error creating node:', error);
      setError('Failed to create node');
    }
  }, []);

  const handleEdgeAdd = useCallback(async (edgeData: Omit<GraphEdge, 'id'>) => {
    try {
      const response = await authFetch('/api/v1/graph/edges', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(edgeData),
      });

      if (!response.ok) {
        throw new Error('Failed to create edge');
      }

      const createdEdge = await response.json();
      
      setGraphData(prev => ({
        ...prev,
        edges: [...prev.edges, createdEdge]
      }));

      setShowAddEdge(false);
    } catch (error) {
      console.error('Error creating edge:', error);
      setError('Failed to create edge');
    }
  }, []);

  const handleNodeDelete = useCallback(async (nodeId: string) => {
    try {
      console.log(`Attempting to delete node: ${nodeId}`);
      
      const response = await authFetch(`/api/v1/graph/nodes/${nodeId}`, {
        method: 'DELETE',
      });

      if (response.status === 401) {
        setError('Authentication failed. Please refresh the page and log in again.');
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Failed to delete node' }));
        throw new Error(errorData.message || `Failed to delete node (${response.status})`);
      }

      setGraphData(prev => ({
        nodes: prev.nodes.filter(node => node.id !== nodeId),
        edges: prev.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId)
      }));
      setSelectedNode(null);
      setError(null); // Clear any previous errors
      
      console.log(`Successfully deleted node: ${nodeId}`);
    } catch (error) {
      console.error('Error deleting node:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete node';
      setError(errorMessage);
    }
  }, []);


  const clearGraph = useCallback(async () => {
    if (window.confirm('Are you sure you want to clear the entire graph? This action cannot be undone.')) {
      try {
        const response = await authFetch('/api/v1/graph/clear', {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error('Failed to clear graph');
        }

        // Refresh to get updated graph data
        await refreshGraph();
        setSelectedNode(null);
        setSelectedEdge(null);
      } catch (error) {
        console.error('Error clearing graph:', error);
        setError('Failed to clear graph');
      }
    }
  }, [refreshGraph]);

  const nodeTypeCounts = graphData.nodes.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {} as Record<NodeType, number>);

  return (
    <div className="py-4 pl-2 pr-4 md:py-4 md:pl-3 md:pr-6 h-full bg-white dark:bg-[#1E1E1E]">
      <div className="w-full h-full flex flex-col">
        {/* Header - matching Knowledge Management styling */}
        <div className="flex justify-between items-center mt-6 mb-12">
          <h1 className="text-[26px] font-display text-gray-700 dark:text-gray-100 tracking-wider">
            KNOWLEDGE GRAPH
          </h1>
          <div className="flex items-center gap-4">
            {error && (
              <span className="text-sm text-red-600 dark:text-red-400">
                {error}
              </span>
            )}
            <Button
              onClick={() => setLayoutMode(layoutMode === 'hierarchy' ? 'graph' : 'hierarchy')}
              className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 text-white rounded-full px-4 py-2 flex items-center gap-2"
              title={`Switch to ${layoutMode === 'hierarchy' ? 'Graph' : 'Hierarchy'} mode`}
            >
              {layoutMode === 'hierarchy' ? '🕸️' : '📊'}
              <span className="font-mono text-[12px] font-medium">
                {layoutMode === 'hierarchy' ? 'GRAPH' : 'HIERARCHY'}
              </span>
            </Button>
            <Button
              onClick={refreshGraph}
              disabled={loading}
              className="bg-slate-800 hover:bg-slate-700 dark:bg-[#2d2d2d] dark:hover:bg-[#404040] text-white rounded-full px-4 py-2 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '⏳' : '🔄'}
              <span className="font-mono text-[12px] font-medium">
                REFRESH
              </span>
            </Button>
            <Button
              onClick={clearGraph}
              className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 text-white rounded-full px-4 py-2 flex items-center gap-2"
            >
              🗑️
              <span className="font-mono text-[12px] font-medium">
                CLEAR
              </span>
            </Button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left Sidebar - optimized for minimal wasted space */}
          <div className="w-52 bg-gray-100 dark:bg-[#1E1E1E] flex flex-col border-r border-gray-200 dark:border-gray-700 mr-2">
            {/* Sidebar Header */}
            <div className="px-2 py-1">
              <h2 className="text-xs font-bold font-mono text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                CTRL
              </h2>
            </div>

            <div className="flex-1 overflow-y-auto px-2 space-y-2">
              {/* Add Node Section */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Add</h3>
                <div className="space-y-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowAddNode(!showAddNode);
                      setShowAddEdge(false);
                    }}
                    className="w-full text-sm h-8 px-1"
                  >
                    ➕ Node
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowAddEdge(!showAddEdge);
                      setShowAddNode(false);
                    }}
                    className="w-full text-sm h-8 px-1"
                    disabled={graphData.nodes.length < 2}
                  >
                    🔗 Edge
                  </Button>
                </div>
              </div>

              {/* Stats */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Stats</h3>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  <div>N: {graphData.nodes.length}</div>
                  <div>E: {graphData.edges.length}</div>
                </div>
              </div>

              {/* Filter */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Filter</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-between text-sm h-8 px-1">
                      {filterType === 'all' ? (
                        `All (${graphData.nodes.length})`
                      ) : (
                        `${NODE_TYPE_CONFIG[filterType].icon} ${NODE_TYPE_CONFIG[filterType].label} (${nodeTypeCounts[filterType] || 0})`
                      )}
                      <span className="ml-1">▼</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-52">
                    <DropdownMenuItem
                      onClick={() => setFilterType('all')}
                      className={filterType === 'all' ? 'bg-gray-100 dark:bg-gray-700' : ''}
                    >
                      All ({graphData.nodes.length})
                    </DropdownMenuItem>
                    {Object.entries(NODE_TYPE_CONFIG).map(([type, config]) => {
                      const count = nodeTypeCounts[type as NodeType] || 0;
                      return (
                        <DropdownMenuItem
                          key={type}
                          onClick={() => setFilterType(type as NodeType)}
                          className={filterType === type ? 'bg-gray-100 dark:bg-gray-700' : ''}
                        >
                          {config.icon} {config.label} ({count})
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Add Node Form */}
              {showAddNode && (
                <AddNodeForm 
                  onNodeAdd={handleNodeAdd}
                  onCancel={() => setShowAddNode(false)}
                />
              )}

              {/* Add Edge Form */}
              {showAddEdge && (
                <AddEdgeForm
                  nodes={graphData.nodes}
                  onEdgeAdd={handleEdgeAdd}
                  onCancel={() => setShowAddEdge(false)}
                />
              )}

              {/* Selected Node Details */}
              {selectedNode && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 bg-white dark:bg-gray-800">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Selected Node</h3>
                  <div className="space-y-1 text-sm">
                    <div>
                      <strong>Name:</strong> {selectedNode.name}
                    </div>
                    <div>
                      <strong>Type:</strong> {NODE_TYPE_CONFIG[selectedNode.type].icon} {NODE_TYPE_CONFIG[selectedNode.type].label}
                    </div>
                    <div>
                      <strong>Description:</strong> {selectedNode.description}
                    </div>
                    {/* Source indicator */}
                    <div>
                      <strong>Source:</strong> {
                        selectedNode.id.startsWith('node_') ? (
                          <Badge variant="secondary" className="ml-1 text-xs">
                            Custom
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-1 text-xs">
                            Auto-generated
                          </Badge>
                        )
                      }
                    </div>
                    {selectedNode.metadata && Object.keys(selectedNode.metadata).length > 0 && (
                      <div>
                        <strong>Metadata:</strong>
                        <pre className="mt-1 text-xs bg-gray-100 dark:bg-gray-700 p-1 rounded">
                          {JSON.stringify(selectedNode.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleNodeDelete(selectedNode.id)}
                      className="w-full mt-2 h-8 text-sm px-1"
                      disabled={!selectedNode.id.startsWith('node_')}
                    >
                      🗑️ Delete Node
                    </Button>
                    {!selectedNode.id.startsWith('node_') && (
                      <div className="mt-1 p-2 bg-gray-100 dark:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-400">
                        ℹ️ Auto-generated nodes from your collections and files cannot be deleted directly. Manage them through the Knowledge Base.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Selected Edge Details */}
              {selectedEdge && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 bg-white dark:bg-gray-800">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Selected Edge</h3>
                  <div className="space-y-1 text-sm">
                    <div>
                      <strong>From:</strong> {graphData.nodes.find(n => n.id === selectedEdge.from)?.name}
                    </div>
                    <div>
                      <strong>To:</strong> {graphData.nodes.find(n => n.id === selectedEdge.to)?.name}
                    </div>
                    <div>
                      <strong>Relationship:</strong> {selectedEdge.relationship}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Main Graph Area */}
          <div className="flex-1 min-h-0">
            <GraphVisualization
              graphData={filteredData}
              width={dimensions.width}
              height={dimensions.height}
              onNodeClick={setSelectedNode}
              onEdgeClick={setSelectedEdge}
              onBackgroundClick={() => {
                setSelectedNode(null);
                setSelectedEdge(null);
              }}
              darkMode={theme === 'dark'}
              layoutMode={layoutMode}
              className="w-full h-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
