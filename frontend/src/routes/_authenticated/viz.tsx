import { createFileRoute, useRouterState } from "@tanstack/react-router"

import React, { useState, useCallback, useRef, useEffect } from "react"
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  ReactFlowProvider,
  NodeTypes,
  ConnectionLineType,
  MarkerType,
  useReactFlow, // Added this import
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { CodeNode } from "@/components/nodes/CodeNode"
import { ConditionalNode } from "@/components/nodes/ConditionalNode"
import { MatchNode } from "@/components/nodes/MatchNode"
import { LoopNode } from "@/components/nodes/LoopNode"

// Custom node types
const nodeTypes: NodeTypes = {
  customNode: CodeNode,
  conditional: ConditionalNode,
  match: MatchNode,
  loop: LoopNode,
  // 'error' type is missing if you intend to use it
}

// Default empty flow
const initialFlow = {
  nodes: [
    {
      id: "empty",
      type: "default",
      data: { label: "Upload a code flow JSON file to visualize" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
}

// This is the inner component that will use React Flow hooks
const ReactFlowContent: React.FC = () => {
  // Reference to file input
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlow.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges)

  // Loading status
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Handle connection between nodes
  const onConnect = useCallback(
    (params) =>
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: "step",
            animated: false,
            style: { stroke: "#888", strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          eds,
        ),
      ),
    [setEdges],
  )

  // Now we can safely use useReactFlow here
  const { fitView } = useReactFlow()

  // Fit view on load or when nodes change significantly
  useEffect(() => {
    if (nodes.length > 0) {
      setTimeout(() => {
        fitView({ padding: 0.2 })
      }, 250)
    }
  }, [nodes.length, fitView])

  // Handle file upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const file = event.target.files?.[0]

    if (!file) return

    setLoading(true)

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string
        const flowData = JSON.parse(content)

        if (!flowData.nodes || !Array.isArray(flowData.nodes)) {
          throw new Error("Invalid flow data: nodes array is missing")
        }

        // Update flow
        setNodes(flowData.nodes)
        setEdges(flowData.edges || [])
        setLoading(false)
      } catch (err: any) {
        console.error("Failed to parse JSON:", err)
        setError(`Failed to parse JSON: ${err.message}`)
        setLoading(false)
      }
    }

    reader.onerror = () => {
      setError("Failed to read the file")
      setLoading(false)
    }

    reader.readAsText(file)
  }

  // Trigger file dialog
  const openFileDialog = () => {
    fileInputRef.current?.click()
  }

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={1.5}
        defaultEdgeOptions={{
          type: "step",
          style: { strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
        connectionLineType={ConnectionLineType.Step}
        proOptions={{ hideAttribution: true }}
      >
        <Controls />
        <MiniMap />
        <Background variant="dots" gap={12} size={1} />

        {/* Upload panel */}
        <Panel
          position="top-left"
          style={{ padding: "10px", background: "#fff", borderRadius: "5px" }}
        >
          {/* <h3 style={{ margin: '0 0 10px 0' }}>Rust Code Flow Visualizer</h3> */}
          <button
            onClick={openFileDialog}
            style={{
              padding: "8px 16px",
              background: "#0066cc",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Upload Code Flow JSON
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".json"
            style={{ display: "none" }}
          />
          {loading && <p>Loading...</p>}
          {error && <p style={{ color: "red" }}>{error}</p>}
        </Panel>
      </ReactFlow>
    </div>
  )
}

// This is the wrapper component that provides the context
const CodeFlowVisualizer: React.FC = ({ user, workspace }) => {
  return (
    <ReactFlowProvider>
      <ReactFlowContent />
    </ReactFlowProvider>
  )
}

export const Route = createFileRoute("/_authenticated/viz")({
  beforeLoad: async ({ params, context }) => {
    // @ts-ignore
    const userWorkspace = context
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <CodeFlowVisualizer user={user} workspace={workspace} />
  },
})
