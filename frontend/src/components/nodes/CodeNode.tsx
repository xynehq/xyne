import React, { memo, useState, useEffect, useRef } from "react"
import { Handle, Position, NodeProps } from "@xyflow/react"
import Prism from "prismjs"
import "prismjs/components/prism-rust"
import "prismjs/themes/prism.css"

export const CodeNode = memo(({ data, selected }: NodeProps) => {
  const [expanded, setExpanded] = useState(false)
  const codeRef = useRef<HTMLElement | null>(null)

  // Determine node appearance based on business logic flag
  const isBusinessLogic = data.isBusinessLogic

  // Format filename and line info
  const fileInfo = data.fileName ? `${data.fileName}:${data.lineNumber}` : ""

  // Process source code to clean it up if needed
  const processSourceCode = (code: string) => {
    return code // Return as-is for now
  }

  // Apply syntax highlighting when code is expanded
  useEffect(() => {
    if (expanded && codeRef.current) {
      Prism.highlightElement(codeRef.current)
    }
  }, [expanded, data.sourceCode])

  return (
    <div
      className={`code-node ${isBusinessLogic ? "business-logic" : ""} ${selected ? "selected" : ""}`}
      style={{
        background: isBusinessLogic
          ? "#e3f2fd"
          : data.isExternal
            ? "#f5f5f5"
            : "#fff",
        border: `2px solid ${isBusinessLogic ? "#1a73e8" : data.isExternal ? "#ccc" : "#888"}`,
        borderRadius: "8px",
        padding: "12px",
        fontSize: "12px",
        position: "relative",
        transition: "all 0.3s ease",
        boxShadow: selected ? "0 0 8px rgba(0,0,0,0.3)" : "none",
        width: expanded ? "500px" : "250px",
        minHeight: "60px",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Badge showing function type */}
      <div
        className="node-badge"
        style={{
          position: "absolute",
          top: "-8px",
          right: "-8px",
          background: isBusinessLogic ? "#1a73e8" : "#888",
          color: "#fff",
          borderRadius: "50%",
          width: "16px",
          height: "16px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: "10px",
          fontWeight: "bold",
        }}
      >
        {isBusinessLogic ? "B" : "F"}
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

      {fileInfo && (
        <div
          style={{
            fontSize: "10px",
            opacity: 0.7,
            marginBottom: "8px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileInfo}
        </div>
      )}

      {/* Flow control indicators */}
      {(data.conditions?.length > 0 ||
        data.loops?.length > 0 ||
        data.errors?.length > 0) && (
        <div
          style={{
            display: "flex",
            gap: "4px",
            marginBottom: "4px",
            flexWrap: "wrap",
          }}
        >
          {data.conditions?.map((c, i) => (
            <span
              key={i}
              style={{
                background: "#fff3cd",
                border: "1px solid #ffeeba",
                padding: "0 4px",
                borderRadius: "3px",
                fontSize: "10px",
              }}
            >
              if
            </span>
          ))}
          {data.loops?.map((l, i) => (
            <span
              key={i}
              style={{
                background: "#d4edda",
                border: "1px solid #c3e6cb",
                padding: "0 4px",
                borderRadius: "3px",
                fontSize: "10px",
              }}
            >
              {l}
            </span>
          ))}
          {data.errors?.length > 0 && (
            <span
              style={{
                background: "#f8d7da",
                border: "1px solid #f5c6cb",
                padding: "0 4px",
                borderRadius: "3px",
                fontSize: "10px",
              }}
            >
              error handling
            </span>
          )}
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
          <pre style={{ margin: "0", padding: "8px" }}>
            <code
              ref={codeRef}
              className="language-rust"
              style={{
                fontFamily: 'Consolas, Monaco, "Andale Mono", monospace',
                fontSize: "12px",
                color: "#f8f8f2",
                textShadow: "0 1px rgba(0, 0, 0, 0.3)",
                whiteSpace: "pre",
                wordWrap: "normal",
              }}
            >
              {processSourceCode(data.sourceCode)}
            </code>
          </pre>
        </div>
      )}

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

      {/* Input/output handles */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "#555", width: "10px", height: "10px" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "#555", width: "10px", height: "10px" }}
      />
    </div>
  )
})

export default CodeNode
