import { createFileRoute } from '@tanstack/react-router'
import { KnowledgeGraphVisualizer } from '@/components/knowledge-graph/KnowledgeGraphVisualizer'

export const Route = createFileRoute('/_authenticated/knowledge-graph')({
  component: KnowledgeGraphPage,
})

function KnowledgeGraphPage() {
  return (
    <div className="h-screen bg-gray-50">
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-3xl font-bold text-gray-900">Knowledge Graph Visualizer</h1>
        <p className="text-gray-600 mt-2">
          Real-time exploration of your Vespa knowledge graph
        </p>
      </div>
      <KnowledgeGraphVisualizer />
    </div>
  )
}
