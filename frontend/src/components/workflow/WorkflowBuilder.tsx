import React, { useCallback, useState, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Node,
  Edge,
  addEdge,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  NodeProps,
  Connection,
  useReactFlow,
  Panel,
  OnSelectionChangeParams,
  OnNodesDelete,
  OnEdgesDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Flow, Step, UserDetail, WorkflowTemplate } from './Types';
import { workflowTemplatesAPI } from './api/ApiHandlers';
import ActionBar from './ActionBar';


// Custom Node Component
const StepNode: React.FC<NodeProps> = ({ data, isConnectable, selected }) => {
  const { step, isActive, isCompleted } = data as { step: Step; isActive?: boolean; isCompleted?: boolean; };
  
  const getNodeClasses = () => {
    const baseClasses = 'rounded-2xl border-2 transition-all duration-300 ease-in-out p-6 min-w-[180px] min-h-[90px] text-center flex flex-col items-center justify-center cursor-pointer relative backdrop-blur-sm';
    
    if (isCompleted) {
      return `${baseClasses} border-emerald-600 bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-900 shadow-lg shadow-emerald-500/15`;
    }
    
    if (isActive) {
      return `${baseClasses} border-blue-600 bg-gradient-to-br from-blue-50 to-blue-100 text-blue-900 shadow-lg shadow-blue-500/15`;
    }
    
    if (selected) {
      return `${baseClasses} border-purple-600 bg-gradient-to-br from-purple-50 to-purple-100 text-purple-900 shadow-xl shadow-purple-500/15`;
    }
    
    return `${baseClasses} border-gray-200 bg-gradient-to-br from-white to-gray-50 text-gray-700 shadow-md shadow-black/8`;
  };

  return (
    <>
      <div className={getNodeClasses()}>
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          className={`w-3 h-3 border-2 border-white shadow-sm ${
            isCompleted ? 'bg-emerald-600' : isActive ? 'bg-blue-600' : 'bg-gray-400'
          }`}
        />
        
        <div className="flex items-center gap-2 mb-1">
          {isCompleted && (
            <div className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
              ✓
            </div>
          )}
          {isActive && (
            <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
          )}
          <div className="font-semibold text-base leading-tight">
            {step.name || 'Unnamed Step'}
          </div>
        </div>
        
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className={`w-3 h-3 border-2 border-white shadow-sm ${
            isCompleted ? 'bg-emerald-600' : isActive ? 'bg-blue-600' : 'bg-gray-400'
          }`}
        />
      </div>
    </>
  );
};

// Header component
const Header = () => {
  return (
    <div className="flex flex-col items-start px-6 py-4 border-b border-slate-200 bg-white min-h-[80px] gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 w-full">
        <div className="text-slate-500 text-sm font-normal leading-5">
          Workflow <span className='text-[#3B4145] text-sm font-medium leading-5'>/ Untitled Workflow</span>
        </div>
      </div>
      
      {/* Full-width divider */}
      <div className="w-full h-px bg-slate-200 -mx-6 self-stretch" />
      
      {/* Editor/Settings Toggle - positioned below divider */}
      <div className="flex items-center rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
        <button className="my-1 mx-1 px-4 py-1.5 bg-white text-slate-800 text-sm font-medium border-none cursor-pointer flex items-center gap-1.5 h-8 min-w-[80px] justify-center rounded-lg shadow-sm">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          Editor
        </button>
        <button className="px-4 py-1.5 bg-transparent text-slate-500 text-sm font-medium border-none cursor-pointer flex items-center gap-1.5 h-8 min-w-[80px] justify-center">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Settings
        </button>
      </div>
    </div>
  );
};

// Right Sidebar - SELECT TRIGGERS Panel
const TriggersSidebar = ({ isVisible, onClose }: { isVisible: boolean; onClose: () => void }) => {
  const triggers = [
    {
      id: 'manual',
      name: 'Trigger Manually',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="16"></line>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
      )
    },
    {
      id: 'app_event',
      name: 'On App Event',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
      )
    },
    {
      id: 'schedule',
      name: 'On Schedule',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      )
    },
    {
      id: 'webhook',
      name: 'On Webhook Call',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      )
    },
    {
      id: 'form',
      name: 'On Form Submission',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
      )
    },
    {
      id: 'workflow',
      name: 'When executed by another workflow',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>
      )
    },
    {
      id: 'chat',
      name: 'On Chat Message',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      )
    }
  ];

  const resources = [
    {
      id: 'create_workflow',
      name: 'How to create a workflow',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      )
    },
    {
      id: 'templates',
      name: 'Templates',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
      )
    }
  ];

  return (
    <div className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
      isVisible ? 'translate-x-0 w-[380px]' : 'translate-x-full w-0'
    }`}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200">
        <div className="text-sm font-semibold text-gray-700 tracking-wider uppercase mb-1.5">
          SELECT TRIGGERS
        </div>
        <div className="text-sm text-slate-500 leading-5 font-normal">
          Trigger is an action that will initiate the workflow.
        </div>
      </div>

      {/* Triggers List */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-1">
        {triggers.map((trigger) => (
          <div
            key={trigger.id}
            className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all duration-150 bg-transparent hover:bg-slate-50 text-slate-700 min-h-[44px]"
          >
            <div className="w-5 h-5 flex items-center justify-center text-slate-500 flex-shrink-0">
              {trigger.icon}
            </div>
            <div className="text-sm font-medium text-slate-700 leading-5">
              {trigger.name}
            </div>
          </div>
        ))}
      </div>

      {/* Helpful Resources Section */}
      <div className="px-6 pt-5 pb-6">
        <div className="text-xs font-semibold text-slate-500 tracking-wider uppercase mb-4">
          HELPFUL RESOURCES
        </div>
        
        {resources.map((resource) => (
          <div
            key={resource.id}
            className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all duration-150 bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 mb-2 min-h-[44px]"
          >
            <div className="w-5 h-5 flex items-center justify-center text-slate-500 flex-shrink-0">
              {resource.icon}
            </div>
            <div className="text-sm font-medium text-slate-700 leading-5">
              {resource.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const EmptyCanvas: React.FC<{
  onAddFirstStep: () => void;
  onStartWithTemplate: () => void;
}> = ({ onAddFirstStep, onStartWithTemplate }) => {
  return (
    <div className="flex flex-col items-center justify-center gap-8 p-12 text-center">
      {/* Main CTA Button */}
      <button
        onClick={onAddFirstStep}
        className="px-8 py-5 bg-white border-2 border-dashed border-slate-300 hover:border-slate-400 rounded-xl text-slate-700 text-base font-medium cursor-pointer flex items-center gap-3 transition-all duration-200 min-w-[200px] justify-center hover:bg-slate-50 hover:-translate-y-px hover:shadow-md"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add first step
      </button>
      
      {/* Divider */}
      <div className="flex items-center gap-4 w-full max-w-[300px]">
        <div className="flex-1 h-px bg-slate-200" />
        <div className="text-slate-500 text-sm font-medium uppercase tracking-wider">
          OR
        </div>
        <div className="flex-1 h-px bg-slate-200" />
      </div>
      
      {/* Secondary Button */}
      <button
        onClick={onStartWithTemplate}
        className="px-6 py-3 bg-white border border-slate-200 hover:border-slate-300 rounded-lg text-slate-700 text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-slate-50 hover:shadow-sm"
      >
        Start with a Template
      </button>
    </div>
  );
};



const nodeTypes = {
  stepNode: StepNode,
};

interface WorkflowBuilderProps {
  flow?: Flow;
  activeStepId?: string;
  onStepClick?: (step: Step) => void;
  user?: UserDetail;
}

// Internal component that uses ReactFlow hooks
const WorkflowBuilderInternal: React.FC<WorkflowBuilderProps> = ({ 
  onStepClick, 
}) => {
  const [selectedNodes, setSelectedNodes] = useState<Node[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Edge[]>([]);
  const [nodeCounter, setNodeCounter] = useState(1);
  const [showEmptyCanvas, setShowEmptyCanvas] = useState(true);
  const [showTriggersSidebar, setShowTriggersSidebar] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [workflowTemplates, setWorkflowTemplates] = useState<WorkflowTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  
  // Empty initial state
  const initialNodes: Node[] = [];
  const initialEdges: Edge[] = [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { fitView, zoomTo } = useReactFlow();

  // Fetch workflow templates on component mount
  useEffect(() => {
    const fetchWorkflowTemplates = async () => {
      setIsLoadingTemplates(true);
      setTemplatesError(null);
      
      const response = await workflowTemplatesAPI.fetchAll();
      
      if (response.error) {
        console.error('Error fetching workflow templates:', response.error);
        setTemplatesError(response.error);
      } else if (response.data) {
        setWorkflowTemplates(response.data);
        console.log('Fetched workflow templates:', response.data);
      }
      
      setIsLoadingTemplates(false);
    };

    fetchWorkflowTemplates();
  }, []);


  const onConnect = useCallback(
    (params: Connection) => {
      const newEdge = {
        ...params,
        id: `${params.source}-${params.target}`,
        type: 'smoothstep',
        animated: true,
        style: {
          stroke: '#3B82F6',
          strokeWidth: 2,
        },
        markerEnd: {
          type: 'arrowclosed',
          color: '#3B82F6',
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges]
  );

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelectedNodes(params.nodes);
    setSelectedEdges(params.edges);
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (onStepClick && node.data?.step) {
      onStepClick(node.data.step as Step);
    }
  }, [onStepClick]);

  const onNodesDelete = useCallback<OnNodesDelete>((deleted) => {
    console.log('Nodes deleted:', deleted);
    if (nodes.length === deleted.length) {
      setShowEmptyCanvas(true);
    }
  }, [nodes.length]);

  const onEdgesDelete = useCallback<OnEdgesDelete>((deleted) => {
    console.log('Edges deleted:', deleted);
  }, []);

  const addFirstStep = useCallback(() => {
    setShowTriggersSidebar(true);
    const newNode: Node = {
      id: '1',
      type: 'stepNode',
      position: { x: 400, y: 200 },
      data: { 
        step: { 
          id: '1', 
          name: 'Select trigger from the sidebar', 
          status: 'PENDING',
          contents: []
        }, 
        isActive: false, 
        isCompleted: false 
      },
      draggable: true,
    };
    
    setNodes([newNode]);
    setNodeCounter(2);
    setShowEmptyCanvas(false);
    
    setTimeout(() => {
      fitView({ padding: 0.2 });
    }, 50);
  }, [setNodes, fitView]);

  const startWithTemplate = useCallback(() => {
    // Create a workflow template based on the image
    const templateNodes: Node[] = [
      {
        id: '1',
        type: 'stepNode',
        position: { x: 540, y: 120 },
        data: { 
          step: { 
            id: '1', 
            name: 'Chat Message', 
            status: 'PENDING',
            contents: [{
              type: 'TRIGGER',
              value: 'When chat message received'
            }]
          }, 
          isActive: false, 
          isCompleted: false 
        },
        draggable: true,
      },
      {
        id: '2',
        type: 'stepNode',
        position: { x: 540, y: 280 },
        data: { 
          step: { 
            id: '2', 
            name: 'AI Agent', 
            status: 'PENDING',
            contents: [{
              type: 'AGENT',
              value: 'gpt-oss-120b'
            }]
          }, 
          isActive: false, 
          isCompleted: false 
        },
        draggable: true,
      },
      {
        id: '3',
        type: 'stepNode',
        position: { x: 400, y: 440 },
        data: { 
          step: { 
            id: '3', 
            name: 'Select trigger from the sidebar', 
            status: 'PENDING',
            contents: [{
              type: 'CONDITION',
              value: 'if false'
            }]
          }, 
          isActive: false, 
          isCompleted: false 
        },
        draggable: true,
      },
      {
        id: '4',
        type: 'stepNode',
        position: { x: 680, y: 440 },
        data: { 
          step: { 
            id: '4', 
            name: 'Select trigger from the sidebar', 
            status: 'PENDING',
            contents: [{
              type: 'CONDITION',
              value: 'if true'
            }]
          }, 
          isActive: false, 
          isCompleted: false 
        },
        draggable: true,
      }
    ];

    const templateEdges: Edge[] = [
      {
        id: '1-2',
        source: '1',
        target: '2',
        type: 'smoothstep',
        animated: false,
        style: {
          stroke: '#6B7280',
          strokeWidth: 2,
        },
        markerEnd: {
          type: 'arrowclosed',
          color: '#6B7280',
        },
      },
      {
        id: '2-3',
        source: '2',
        target: '3',
        type: 'smoothstep',
        animated: false,
        style: {
          stroke: '#6B7280',
          strokeWidth: 2,
        },
        markerEnd: {
          type: 'arrowclosed',
          color: '#6B7280',
        },
        label: 'if false',
      },
      {
        id: '2-4',
        source: '2',
        target: '4',
        type: 'smoothstep',
        animated: false,
        style: {
          stroke: '#6B7280',
          strokeWidth: 2,
        },
        markerEnd: {
          type: 'arrowclosed',
          color: '#6B7280',
        },
        label: 'if true',
      }
    ];
    
    setNodes(templateNodes);
    setEdges(templateEdges);
    setNodeCounter(4);
    setShowEmptyCanvas(false);
    
    setTimeout(() => {
      fitView({ padding: 0.2 });
    }, 50);
  }, [setNodes, setEdges, fitView]);

  const addNewNode = useCallback(() => {
    const newNode: Node = {
      id: nodeCounter.toString(),
      type: 'stepNode',
      position: { 
        x: Math.random() * 400 + 200, 
        y: Math.random() * 300 + 150 
      },
      data: { 
        step: { 
          id: nodeCounter.toString(), 
          name: `New Step ${nodeCounter}`, 
          status: 'PENDING',
          contents: []
        }, 
        isActive: false, 
        isCompleted: false 
      },
      draggable: true,
    };
    
    setNodes((nds) => [...nds, newNode]);
    setNodeCounter(prev => prev + 1);
    setShowEmptyCanvas(false);
  }, [nodeCounter, setNodes]);

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodes.length > 0) {
      const nodeIdsToDelete = selectedNodes.map(node => node.id);
      setNodes((nds) => nds.filter(node => !nodeIdsToDelete.includes(node.id)));
      setEdges((eds) => eds.filter(edge => 
        !nodeIdsToDelete.includes(edge.source) && !nodeIdsToDelete.includes(edge.target)
      ));
    }
  }, [selectedNodes, setNodes, setEdges]);

  const handleZoomChange = useCallback((zoom: number) => {
    setZoomLevel(zoom);
    zoomTo(zoom / 100);
  }, [zoomTo]);

  const executeNode = useCallback(() => {
    if (selectedNodes.length === 1) {
      const selectedNode = selectedNodes[0];
      console.log('Executing node:', selectedNode.id);
      // Here you would implement the actual execution logic
      
      // For demonstration, let's mark the node as completed
      setNodes(nodes => nodes.map(node => {
        if (node.id === selectedNode.id) {
          return {
            ...node,
            data: {
              ...node.data,
              isCompleted: true
            }
          };
        }
        return node;
      }));
    }
  }, [selectedNodes, setNodes]);


  return (
    <div className="w-full h-full flex flex-col bg-white relative">
      {/* Header */}
      <Header />
      
      {/* Main content area */}
      <div className="flex flex-1 relative overflow-hidden">
        {/* Flow diagram area */}
        <div className="flex-1 bg-slate-50 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        className="bg-gray-100 dark:bg-slate-900"
        multiSelectionKeyCode="Shift"
        deleteKeyCode="Delete"
        snapToGrid={true}
        snapGrid={[15, 15]}
      >
        {/* Selection Info Panel */}
        {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
          <Panel position="top-right">
            <div className="bg-white p-3 rounded-lg shadow-md border border-slate-200 min-w-[200px]">
              <div className="text-sm font-semibold mb-2">
                Selection Info
              </div>
              <div className="text-xs text-gray-500">
                Nodes: {selectedNodes.length} | Edges: {selectedEdges.length}
              </div>
              {selectedNodes.length === 1 && selectedNodes[0].data?.step ? (
                <div className="text-xs mt-1">
                  <strong>Step:</strong> {(selectedNodes[0].data.step as Step).name || 'Unnamed'}
                </div>
              ) : null}
            </div>
          </Panel>
        )}

        {/* Empty Canvas Content */}
        {showEmptyCanvas && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[5] text-center">
            <EmptyCanvas 
              onAddFirstStep={addFirstStep}
              onStartWithTemplate={startWithTemplate}
            />
          </div>
        )}
        <Background 
          variant={BackgroundVariant.Dots} 
          gap={12} 
          size={1}
          className="bg-gray-50 dark:bg-slate-900"
        />

        {/* Action Bar at bottom center */}
        {!showEmptyCanvas && (
          <Panel position="bottom-center">
            <ActionBar 
              onExecute={executeNode} 
              zoomLevel={zoomLevel} 
              onZoomChange={handleZoomChange} 
            />
          </Panel>
        )}
      </ReactFlow>
        </div>
        
        {/* Right Triggers Sidebar */}
        <TriggersSidebar 
          isVisible={showTriggersSidebar} 
          onClose={() => setShowTriggersSidebar(false)}
        />
      </div>
    </div>
  );
};

// Main component wrapped with ReactFlowProvider
const WorkflowBuilder: React.FC<WorkflowBuilderProps> = (props) => {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInternal {...props} />
    </ReactFlowProvider>
  );
};

export default WorkflowBuilder;
