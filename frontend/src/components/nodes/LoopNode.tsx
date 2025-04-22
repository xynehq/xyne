import React, { useState, useEffect, useRef } from "react"
import { Handle, Position } from "@xyflow/react"
import Prism from "prismjs"
import "prismjs/components/prism-rust"
import "prismjs/themes/prism-tomorrow.css"

interface LoopNodeData {
  label: string
  sourceCode: string
  fileName?: string
  lineNumber?: number
  loops?: string[]
}

export const LoopNode = ({ data }: { data: LoopNodeData }) => {
  const [expanded, setExpanded] = useState(false)
  const codeRef = useRef<HTMLPreElement>(null)

  // Format file info
  const fileInfo = data.fileName
    ? `${data.fileName}:${data.lineNumber || "?"}`
    : ""

  // Format loop type
  const loopType = data.loops?.join(", ") || "loop"

  // Apply highlighting when expanded changes
  useEffect(() => {
    if (expanded && codeRef.current) {
      Prism.highlightAllUnder(codeRef.current)
    }
  }, [expanded])

  return (
    <div
      style={{
        padding: "10px",
        borderRadius: "8px",
        background: "#e8f5e9",
        border: "2px solid #43a047",
        minWidth: "200px",
        maxWidth: expanded ? "500px" : "250px",
        fontSize: "12px",
        transition: "all 0.3s ease",
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <Handle type="target" position={Position.Top} />

      {/* Node badge - indicating loop */}
      <div
        style={{
          position: "absolute",
          top: "-8px",
          right: "-8px",
          background: "#43a047",
          color: "#fff",
          borderRadius: "50%",
          width: "16px",
          height: "16px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: "10px",
          fontWeight: "bold",
          title: "Loop Node",
        }}
      >
        L
      </div>

      <div
        style={{
          fontWeight: "bold",
          marginBottom: "4px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {data.label}
      </div>

      <div
        style={{
          fontSize: "10px",
          color: "#666",
          marginBottom: "4px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Loop: {loopType}
      </div>

      {fileInfo && (
        <div
          style={{
            fontSize: "10px",
            color: "#666",
            marginBottom: "8px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileInfo}
        </div>
      )}

      {/* Source code section */}
      {expanded && data.sourceCode && (
        <div
          style={{
            marginTop: "8px",
            background: "#282c34",
            borderRadius: "4px",
            maxHeight: "300px",
            overflow: "auto",
            border: "1px solid #444",
          }}
        >
          <pre
            ref={codeRef}
            style={{
              margin: "0",
              padding: "8px",
              fontSize: "11px",
            }}
          >
            <code className="language-rust">{data.sourceCode}</code>
          </pre>
        </div>
      )}

      {/* Indicator text when collapsed */}
      {!expanded && data.sourceCode && (
        <div
          style={{
            fontSize: "11px",
            opacity: 0.7,
            fontStyle: "italic",
            marginTop: "4px",
          }}
        >
          Click to view code
        </div>
      )}

      {!data.sourceCode && (
        <div
          style={{
            fontSize: "11px",
            opacity: 0.7,
            fontStyle: "italic",
            marginTop: "4px",
            background: "#2d2d2d",
            color: "#e0e0e0",
            padding: "8px",
            borderRadius: "4px",
          }}
        >
          Source code not available
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
