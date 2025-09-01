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
import { Flow, TemplateFlow, Step, UserDetail, Tool, StepExecution } from './Types';
import ActionBar from './ActionBar';
import {
  DelayIcon,
  PythonScriptIcon,
  DefaultToolIcon,
  EditorIcon,
  SettingsIcon,
  ManualTriggerIcon,
  AppEventIcon,
  ScheduleIcon,
  WebhookIcon,
  FormSubmissionIcon,
  WorkflowExecutionIcon,
  ChatMessageIcon,
  HelpIcon,
  TemplatesIcon,
  AddIcon
} from './WorkflowIcons';
import { workflowTemplatesAPI, workflowsAPI } from './api/ApiHandlers';


// Tool Card Component
const ToolCard: React.FC<{ tool: Tool }> = ({ tool }) => {
  const getToolIcon = (type: string) => {
    switch (type) {
      case 'delay':
        return <DelayIcon />;
      case 'python_script':
        return <PythonScriptIcon />;
      default:
        return <DefaultToolIcon />;
    }
  };

  const getToolColor = (type: string) => {
    switch (type) {
      case 'delay':
        return 'bg-yellow-50 border-yellow-200 text-yellow-800';
      case 'python_script':
        return 'bg-blue-50 border-blue-200 text-blue-800';
      default:
        return 'bg-gray-50 border-gray-200 text-gray-800';
    }
  };

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium ${getToolColor(tool.type)}`}>
      {getToolIcon(tool.type)}
      <span>{tool.type}</span>
      {tool.config.description && (
        <span className="text-xs opacity-75">• {tool.config.description}</span>
      )}
    </div>
  );
};

// Custom Node Component
const StepNode: React.FC<NodeProps> = ({ data, isConnectable, selected }) => {
  const { step, isActive, isCompleted, tools } = data as { 
    step: Step; 
    isActive?: boolean; 
    isCompleted?: boolean; 
    tools?: Tool[];
  };
  
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
          {isActive && !isCompleted && (
            <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
          )}
          <div className="font-semibold text-base leading-tight">
            {step.name || 'Unnamed Step'}
          </div>
          {isActive && !isCompleted && (
            <div className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
              Running
            </div>
          )}
        </div>
        
        {/* Status indicator */}
        {step.status && (
          <div className="text-xs opacity-70 uppercase tracking-wider font-medium mb-1">
            {step.status === 'running' || step.status === 'in_progress' ? 'In Progress' : 
             step.status === 'completed' || step.status === 'done' ? 'Completed' : 
             step.status === 'pending' ? 'Pending' : 
             step.status}
          </div>
        )}
        
        {/* Display tools below step name */}
        {tools && tools.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 w-full">
            {tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}
        
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
          <EditorIcon />
          Editor
        </button>
        <button className="px-4 py-1.5 bg-transparent text-slate-500 text-sm font-medium border-none cursor-pointer flex items-center gap-1.5 h-8 min-w-[80px] justify-center">
          <SettingsIcon />
          Settings
        </button>
      </div>
    </div>
  );
};

// Right Sidebar - SELECT TRIGGERS Panel
const TriggersSidebar = ({ isVisible }: { isVisible: boolean; onClose?: () => void }) => {
  const triggers = [
    {
      id: 'manual',
      name: 'Trigger Manually',
      icon: <ManualTriggerIcon width={20} height={20} />
    },
    {
      id: 'app_event',
      name: 'On App Event',
      icon: <AppEventIcon width={20} height={20} />
    },
    {
      id: 'schedule',
      name: 'On Schedule',
      icon: <ScheduleIcon width={20} height={20} />
    },
    {
      id: 'webhook',
      name: 'On Webhook Call',
      icon: <WebhookIcon width={20} height={20} />
    },
    {
      id: 'form',
      name: 'On Form Submission',
      icon: <FormSubmissionIcon width={20} height={20} />
    },
    {
      id: 'workflow',
      name: 'When executed by another workflow',
      icon: <WorkflowExecutionIcon width={20} height={20} />
    },
    {
      id: 'chat',
      name: 'On Chat Message',
      icon: <ChatMessageIcon width={20} height={20} />
    }
  ];

  const resources = [
    {
      id: 'create_workflow',
      name: 'How to create a workflow',
      icon: <HelpIcon width={20} height={20} />
    },
    {
      id: 'templates',
      name: 'Templates',
      icon: <TemplatesIcon width={20} height={20} />
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
        <AddIcon />
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
  flow?: Flow | TemplateFlow;
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
  // Template workflow state (for creating the initial workflow)
  const [templateWorkflow, setTemplateWorkflow] = useState<TemplateFlow | null>(null);
  const [, setIsLoadingTemplate] = useState(false);
  const [, setTemplateError] = useState<string | null>(null);
  
  // Running workflow state (for real-time updates)
  const [, setWorkflow] = useState<Flow | null>(null);
  const [, setIsPolling] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);

  // Empty initial state
  const initialNodes: Node[] = [];
  const initialEdges: Edge[] = [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { fitView, zoomTo } = useReactFlow();

  // Fetch specific workflow template by ID on component mount
  useEffect(() => {
    const fetchWorkflowTemplate = async () => {
      const templateId = 'a50e8400-e29b-41d4-a716-446655440010';
      setIsLoadingTemplate(true);
      setTemplateError(null);
      
      try {
        const response = await workflowTemplatesAPI.fetchById(templateId);
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        if (response.data) {
          setTemplateWorkflow(response.data);
        }
      } catch (error) {
        console.error('Fetch error:', error);
        setTemplateError(error instanceof Error ? error.message : 'Network error');
      } finally {
        setIsLoadingTemplate(false);
      }
    };

    fetchWorkflowTemplate();
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

  const onNodesDelete = useCallback<OnNodesDelete>((_deleted) => {
    if (nodes.length === _deleted.length) {
      setShowEmptyCanvas(true);
    }
  }, [nodes.length]);

  const onEdgesDelete = useCallback<OnEdgesDelete>((_deleted) => {
    // Handle edge deletion if needed in the future
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
    if (!templateWorkflow) {
      console.error('No template workflow available');
      return;
    }

    // Convert template workflow template_steps to nodes
    const templateNodes: Node[] = templateWorkflow.template_steps.map((templateStep, index) => {
      // Find the associated tool for this step
      const associatedTool = templateWorkflow.tools?.find(tool => tool.id === templateStep.tool_id);
      
      // Get all tools for this step (in case there are multiple)
      const stepTools = templateStep.tool_id ? 
        templateWorkflow.tools?.filter(tool => tool.id === templateStep.tool_id) || [] : 
        [];
      
      return {
        id: templateStep.id,
        type: 'stepNode',
        position: { 
          x: 200 + (index * 300), 
          y: 200 + (index % 2 === 0 ? 0 : 100) 
        },
        data: { 
          step: {
            id: templateStep.id,
            name: associatedTool ? `${associatedTool.type === 'delay' ? 'Processing Delay' : associatedTool.type === 'python_script' ? (index === 1 ? 'Process Data' : 'Send Notification') : `Step ${index + 1}: ${associatedTool.type}`}` : (index === 0 ? 'Start Workflow' : `Step ${index + 1}`),
            status: 'pending',
            description: associatedTool?.config.description || 'Template step',
            type: associatedTool?.type || 'unknown',
            tool_id: templateStep.tool_id,
            prevStepIds: templateStep.prevStepIds,
            nextStepIds: templateStep.nextStepIds,
            contents: []
          }, 
          tools: stepTools, // Pass tools data to the node
          isActive: false, 
          isCompleted: false 
        },
        draggable: true,
      };
    });

    // Create edges based on nextStepIds
    const templateEdges: Edge[] = [];
    templateWorkflow.template_steps.forEach(templateStep => {
      templateStep.nextStepIds.forEach(nextStepId => {
        templateEdges.push({
          id: `${templateStep.id}-${nextStepId}`,
          source: templateStep.id,
          target: nextStepId,
          type: 'smoothstep',
          animated: false,
          style: {
            stroke: '#3B82F6',
            strokeWidth: 2,
          },
          markerEnd: {
            type: 'arrowclosed',
            color: '#3B82F6',
          },
        });
      });
    });
    
    setNodes(templateNodes);
    setEdges(templateEdges);
    setNodeCounter(templateWorkflow.template_steps.length + 1);
    setShowEmptyCanvas(false);
    
    setTimeout(() => {
      fitView({ padding: 0.2 });
    }, 50);
  }, [templateWorkflow, setNodes, setEdges, fitView]);

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
  }, [nodeCounter, setNodes, setShowEmptyCanvas]);
  
  // Prevent unused variable warning
  void addNewNode;

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodes.length > 0) {
      const nodeIdsToDelete = selectedNodes.map(node => node.id);
      setNodes((nds) => nds.filter(node => !nodeIdsToDelete.includes(node.id)));
      setEdges((eds) => eds.filter(edge => 
        !nodeIdsToDelete.includes(edge.source) && !nodeIdsToDelete.includes(edge.target)
      ));
    }
  }, [selectedNodes, setNodes, setEdges]);
  
  // Prevent unused variable warning
  void deleteSelectedNodes;

  const handleZoomChange = useCallback((zoom: number) => {
    setZoomLevel(zoom);
    zoomTo(zoom / 100);
  }, [zoomTo]);

  // Function to fetch workflow status
  const fetchWorkflowStatus = useCallback(async (workflowId: string) => {
    try {
      const response = await workflowsAPI.fetchById(workflowId);
      
      if (response.error) {
        throw new Error(`Failed to fetch workflow status: ${response.error}`);
      }

      if (!response.data) {
        throw new Error('No workflow data received');
      }
      
      const workflowData = response.data;
      
      // Update the running workflow state
      setWorkflow(workflowData);
      
      // Update nodes based on workflow step statuses - match by step name
      if (workflowData?.step_exe) {
        setNodes(currentNodes => 
          currentNodes.map(node => {
            // Try to match by step name first, then fall back to id
            const stepExeArray = workflowData.step_exe as StepExecution[];
            const matchingStep = stepExeArray?.find((stepItem) => {
              const step = stepItem as StepExecution;
              // Match by step name (more reliable for template vs running workflow)  
              const nodeStep = node.data?.step as Step;
              if (nodeStep?.name && step.name) {
                const nameMatch = nodeStep.name === step.name;
                return nameMatch;
              }
              // Fall back to ID matching
              const idMatch = (step as any)?.id === node.id;
              return idMatch;
            });
            
            if (matchingStep) {
              return {
                ...node,
                data: {
                  ...node.data,
                  isActive: matchingStep.status === 'running' || matchingStep.status === 'in_progress',
                  isCompleted: matchingStep.status === 'completed' || matchingStep.status === 'done',
                  step: node.data.step ? {
                    ...node.data.step,
                    status: matchingStep.status
                  } : {
                    id: matchingStep?.id || node.id,
                    name: matchingStep?.name || 'Unknown Step',
                    status: matchingStep?.status || 'unknown',
                    contents: []
                  }
                }
              };
            }
            return node;
          })
        );
      }
      
      // Check if workflow is completed or failed to stop polling
      if (workflowData?.workflow_info?.status === 'completed' || workflowData?.workflow_info?.status === 'failed' || workflowData?.workflow_info?.status === 'cancelled') {
        stopPolling();
      }
      
    } catch (error) {
      console.error('Error fetching workflow status:', error);
    }
  }, [setWorkflow, setNodes]);

  // Function to start polling
  const startPolling = useCallback((workflowId: string) => {
    setIsPolling(true);
    
    // Clear any existing interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    // Start polling every second
    const interval = setInterval(() => {
      fetchWorkflowStatus(workflowId);
    }, 1000);
    
    setPollingInterval(interval);
  }, [pollingInterval, fetchWorkflowStatus, setIsPolling, setPollingInterval]);

  // Function to stop polling
  const stopPolling = useCallback(() => {
    setIsPolling(false);
    
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
  }, [pollingInterval, setIsPolling, setPollingInterval]);

  // Cleanup polling on component unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  const executeNode = useCallback(async () => {
    if (!templateWorkflow) {
      console.error('No workflow template loaded');
      return;
    }
    
    try {
      // Step 1: Instantiate the workflow template
      const instantiateResponse = await workflowTemplatesAPI.instantiate(templateWorkflow.template_id, {
        name: "Test Webhook Flow",
        metadata: {
          description: "Testing webhook workflow",
          environment: "test"
        }
      });
      
      if (instantiateResponse.error || !instantiateResponse.data) {
        throw new Error(`Failed to instantiate workflow: ${instantiateResponse.error || 'No data returned'}`);
      }
      
      const workflowInstance = instantiateResponse.data;
      
      // Set initial workflow state after instantiation
      try {
        const initialWorkflowResponse = await workflowsAPI.fetchById(workflowInstance.workflowId);
        
        if (!initialWorkflowResponse.error && initialWorkflowResponse.data) {
          setWorkflow(initialWorkflowResponse.data);
        }
      } catch (error) {
        console.warn('Failed to fetch initial workflow state:', error);
      }
      
      // Step 2: Run the workflow
      const runResponse = await workflowsAPI.run(workflowInstance.workflowId);
      
      if (runResponse.error) {
        throw new Error(`Failed to run workflow: ${runResponse.error}`);
      }
      
      // const runResult = runResponse.data; // Not used currently
      
      // Step 3: Complete a workflow step (root step ID)
      const stepCompleteResponse = await workflowsAPI.completeStep(workflowInstance.rootStepId);

      if (stepCompleteResponse.error) {
        console.warn(`Failed to complete step: ${stepCompleteResponse.error}`);
        // Continue execution even if step completion fails
      } 
      
      // Mark all nodes as active/running initially
      setNodes(nodes => nodes.map(node => ({
        ...node,
        data: {
          ...node.data,
          isActive: true,
          isCompleted: false
        }
      })));
      
      // Start polling for workflow status updates
      startPolling(workflowInstance.workflowId);
      
    } catch (error) {
      console.error('Error executing workflow:', error);
      // You could add error state here to show in UI
    }
  }, [templateWorkflow, setNodes, startPolling, setWorkflow]);


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
