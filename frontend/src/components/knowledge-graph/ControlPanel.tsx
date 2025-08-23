import { Settings, Eye, Download, Globe } from 'lucide-react'

interface ControlPanelProps {
  depth: number
  layout: string
  onDepthChange: (depth: number) => void
  onLayoutChange: (layout: string) => void
  onFitView: () => void
  onExport: () => void
  onShowOverview?: () => void
}

export function ControlPanel({
  depth,
  layout,
  onDepthChange,
  onLayoutChange,
  onFitView,
  onExport,
  onShowOverview
}: ControlPanelProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
        <Settings className="h-5 w-5 mr-2" />
        Visualization
      </h3>
      
      <div className="space-y-4">
        {/* Traversal Depth */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Traversal Depth
          </label>
          <select
            value={depth}
            onChange={(e) => onDepthChange(parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value={1}>1 Level</option>
            <option value={2}>2 Levels</option>
            <option value={3}>3 Levels</option>
            <option value={4}>4 Levels</option>
          </select>
        </div>
        
        {/* Layout Algorithm */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Layout Algorithm
          </label>
          <select
            value={layout}
            onChange={(e) => onLayoutChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="cose">COSE (Force-directed)</option>
            <option value="circle">Circle</option>
            <option value="grid">Grid</option>
            <option value="breadthfirst">Breadth-first</option>
            <option value="concentric">Concentric</option>
          </select>
        </div>
        
        {/* Actions */}
        <div className="space-y-2">
          {onShowOverview && (
            <button
              onClick={onShowOverview}
              className="w-full px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center justify-center"
            >
              <Globe className="h-4 w-4 mr-2" />
              Show Overview
            </button>
          )}
          
          <button
            onClick={onFitView}
            className="w-full px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors flex items-center justify-center"
          >
            <Eye className="h-4 w-4 mr-2" />
            Fit View
          </button>
          
          <button
            onClick={onExport}
            className="w-full px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors flex items-center justify-center"
          >
            <Download className="h-4 w-4 mr-2" />
            Export PNG
          </button>
        </div>
      </div>
    </div>
  )
}
