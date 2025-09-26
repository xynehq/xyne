import React, { useEffect, useState } from "react"

interface TxtViewerProps {
  source: File
  className?: string
  style?: React.CSSProperties
}

const TxtViewer: React.FC<TxtViewerProps> = ({ source, className, style }) => {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      if (!text) return

      setLines(text.split(/\r?\n/))
    }

    reader.readAsText(source)
  }, [source])

  return (
    <div
      className={`font-mono text-sm bg-background text-foreground p-2 border rounded ${className}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflowY: "auto",
        ...style,
      }}
    >
      {lines.map((line, idx) => (
        <div key={idx}>{line}</div>
      ))}
    </div>
  )
}

export default TxtViewer
