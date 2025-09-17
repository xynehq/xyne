import React, { useState, useCallback, useEffect, useMemo } from 'react';
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

// Safe accessor for node type config
const getNodeTypeConfig = (type: NodeType | string) => {
  return NODE_TYPE_CONFIG[type as NodeType] || { 
    icon: '❓', 
    color: '#6b7280', 
    label: type || 'Unknown',
    size: 16 
  };
};
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
  const [layoutMode, setLayoutMode] = useState<'graph' | 'hierarchy'>('graph');
  const [permission, setPermission] = useState<string>('beckn@juspay.in');

  // Calculate responsive dimensions
  const calculateDimensions = useCallback(() => {
    const sidebarWidth = 288; // KG sidebar width (w-72)
    const xyneSidebarWidth = 52; // Main Xyne sidebar width
    const leftPadding = 12; // pl-3 = 12px
    const rightPadding = 24; // pr-6 = 24px
    const headerHeight = 160; // Approximate header + padding height
    const sidebarMargin = 8; // mr-2 = 8px margin between sidebar and graph
    
    const availableWidth = window.innerWidth - sidebarWidth - xyneSidebarWidth - leftPadding - rightPadding - sidebarMargin;
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

  const fetchGraphDataWithPermission = useCallback(async (permissionValue?: string) => {
    try {
      setLoading(true);
      setError(null);
      
      const queryParam = permissionValue ? `?permission=${encodeURIComponent(permissionValue)}` : '';
      const response = await authFetch(`/api/v1/graph/data${queryParam}`);
      
      if (response.status === 401) {
        setError('Authentication failed. Please refresh the page and log in again.');
        setGraphData({
          nodes: [
            {
              id: 'auth_error',
              name: 'Authentication Required',
              description: 'Please refresh the page and log in again to access your knowledge graph.',
              type: 'Issue',
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
            type: 'Issue',
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
  }, []);

  // Initialize with default permission on component mount only
  useEffect(() => {
    if (permission) {
      fetchGraphDataWithPermission(permission);
    } else {
      setLoading(false);
      setGraphData({ nodes: [], edges: [] });
    }
  }, []);

  const refreshGraph = useCallback(async () => {
    await fetchGraphDataWithPermission(permission);
  }, [fetchGraphDataWithPermission, permission]);

  const handleFetchByPermission = useCallback(async () => {
    if (!permission.trim()) return;
    await fetchGraphDataWithPermission(permission);
  }, [fetchGraphDataWithPermission, permission]);

  // Filter data based on selected type - memoized to prevent unnecessary re-renders
  const filteredData = useMemo(() => ({
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
  }), [graphData.nodes, graphData.edges, filterType]);

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

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleEdgeClick = useCallback((edge: GraphEdge) => {
    setSelectedEdge(edge);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
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



  const nodeTypeCounts = graphData.nodes.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {} as Record<NodeType, number>);

  return (
    <div className="py-4 pl-2 pr-4 md:py-4 md:pl-3 md:pr-6 h-full bg-white dark:bg-[#1E1E1E]">
      <div className="w-full h-full flex flex-col">
        {/* Header - matching Knowledge Management styling */}
        <div className="flex justify-between items-center mt-6 mb-6">
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
          </div>
        </div>

        {/* Permission Filter Section - Compact */}
        <div className="mb-6 p-4 bg-gradient-to-r from-blue-50 to-green-50 dark:from-blue-900/20 dark:to-green-900/20 rounded-lg border border-blue-200 dark:border-blue-700 shadow-sm">
          <div className="text-center mb-3">
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-100 mb-1">
              🔍 PERMISSION FILTER
            </h2>
          </div>
          
          <div className="flex items-center justify-center gap-4">
            <div className="flex items-center gap-3">
              <label className="text-base font-semibold text-gray-700 dark:text-gray-300 whitespace-nowrap">
                Permission:
              </label>
              <input
                type="text"
                value={permission}
                onChange={(e) => setPermission(e.target.value)}
                placeholder="e.g. bitbucket-no-reply@juspay.email, mohd.shoaib@juspay.in"
                className="px-3 py-2 text-sm border border-blue-300 dark:border-blue-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-w-[350px] shadow-sm"
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && permission.trim()) {
                    handleFetchByPermission();
                  }
                }}
              />
              <Button
                onClick={handleFetchByPermission}
                disabled={loading || !permission.trim()}
                className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 dark:from-green-700 dark:to-green-800 text-white px-6 py-2 text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
              >
                {loading ? '⏳' : '🚀'}
                <span className="font-mono text-sm font-bold tracking-wide">
                  {loading ? 'FETCHING...' : 'FETCH GRAPH'}
                </span>
              </Button>
            </div>
          </div>
          
          {permission && (
            <div className="mt-4 text-center">
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-100 dark:bg-blue-900/50 rounded-full">
                <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  🎯 Currently filtering by:
                </span>
                <span className="font-bold text-blue-900 dark:text-blue-100 px-2 py-1 bg-white dark:bg-gray-800 rounded border">
                  {permission}
                </span>
              </div>
            </div>
          )}
          
          <div className="mt-4 text-xs text-center text-gray-500 dark:text-gray-400">
            💡 Tip: Try using email addresses from the permissions array shown in node metadata
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left Sidebar - wider for better content display */}
          <div className="w-72 bg-gray-100 dark:bg-[#1E1E1E] flex flex-col border-r border-gray-200 dark:border-gray-700 mr-2">
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
                        `${getNodeTypeConfig(filterType).icon} ${getNodeTypeConfig(filterType).label} (${nodeTypeCounts[filterType] || 0})`
                      )}
                      <span className="ml-1">▼</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-72">
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
                          {getNodeTypeConfig(type).icon} {getNodeTypeConfig(type).label} ({count})
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
                      <strong>Type:</strong> {getNodeTypeConfig(selectedNode.type).icon} {getNodeTypeConfig(selectedNode.type).label}
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
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              onBackgroundClick={handleBackgroundClick}
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
