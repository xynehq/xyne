import { BarChart3, GitBranch, Target } from 'lucide-react'
import { GraphData } from './KnowledgeGraphVisualizer'

interface StatsPanelProps {
  graphData: GraphData | null
  selectedEntity: string
}

export function StatsPanel({ graphData, selectedEntity }: StatsPanelProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
        <BarChart3 className="h-5 w-5 mr-2" />
        Graph Statistics
      </h3>
      
      <div className="space-y-4">
        {/* Current View Stats */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 flex items-center">
              <GitBranch className="h-4 w-4 mr-1" />
              Nodes:
            </span>
            <span className="font-semibold text-gray-900">
              {graphData?.nodes.length || 0}
            </span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 flex items-center">
              <GitBranch className="h-4 w-4 mr-1" />
              Edges:
            </span>
            <span className="font-semibold text-gray-900">
              {graphData?.edges.length || 0}
            </span>
          </div>
          
          {selectedEntity && (
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600 flex items-center">
                <Target className="h-4 w-4 mr-1" />
                Center:
              </span>
              <span className="font-semibold text-gray-900 text-xs truncate max-w-[120px]" title={selectedEntity}>
                {selectedEntity}
              </span>
            </div>
          )}
        </div>
        
        {/* Entity Types */}
        {graphData?.metadata.entityTypes && graphData.metadata.entityTypes.length > 0 && (
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Entity Types:</div>
            <div className="space-y-1">
              {graphData.metadata.entityTypes.map((type) => {
                const count = graphData.nodes.filter(n => n.type === type).length
                return (
                  <div key={type} className="flex justify-between items-center text-xs">
                    <span className="text-gray-600">{type}:</span>
                    <span className="font-medium text-gray-900">{count}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        
        {/* Relationship Types */}
        {graphData?.metadata.relationshipTypes && graphData.metadata.relationshipTypes.length > 0 && (
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Relationship Types:</div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {graphData.metadata.relationshipTypes.map((type) => {
                const count = graphData.edges.filter(e => e.type === type).length
                return (
                  <div key={type} className="flex justify-between items-center text-xs">
                    <span className="text-gray-600 truncate mr-2">{type}:</span>
                    <span className="font-medium text-gray-900">{count}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        
        {/* Metadata */}
        {graphData?.metadata && (
          <div className="pt-2 border-t border-gray-200">
            <div className="text-xs text-gray-500">
              Depth: {graphData.metadata.depth}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
