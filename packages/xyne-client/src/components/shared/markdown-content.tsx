import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface MarkdownContentProps {
  content: string
  className?: string
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={`xyne-markdown text-sm ${className ?? ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children, ...props }) => (
            <div className="table-wrapper">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
