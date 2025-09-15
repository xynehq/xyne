import React from "react"
import { Play, Minus, Plus } from "lucide-react"

interface ActionBarProps {
  onExecute?: () => void
  zoomLevel?: number
  onZoomChange?: (zoom: number) => void
  disabled?: boolean
}

const ActionBar: React.FC<ActionBarProps> = ({
  onExecute,
  zoomLevel = 100,
  onZoomChange,
  disabled = false,
}) => {
  const handleZoomIn = () => {
    const zoomLevels = [50, 75, 100, 125, 150, 175, 200]
    const currentIndex = zoomLevels.indexOf(zoomLevel)
    if (currentIndex < zoomLevels.length - 1 && onZoomChange) {
      onZoomChange(zoomLevels[currentIndex + 1])
    }
  }

  const handleZoomOut = () => {
    const zoomLevels = [50, 75, 100, 125, 150, 175, 200]
    const currentIndex = zoomLevels.indexOf(zoomLevel)
    if (currentIndex > 0 && onZoomChange) {
      onZoomChange(zoomLevels[currentIndex - 1])
    }
  }

  return (
    <div className="flex items-center gap-2 bg-white p-1.5 rounded-full shadow-sm border border-blue-100 border-dashed">
      <button
        onClick={disabled ? undefined : onExecute}
        disabled={disabled}
        className={`px-4 py-2 border-none rounded-full text-sm font-medium flex items-center gap-1.5 transition-all duration-200 ${
          disabled 
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
            : 'bg-slate-800 hover:bg-slate-700 text-white cursor-pointer'
        }`}
      >
        <Play className="w-4 h-4" fill="currentColor" />
        Execute Workflow
      </button>

      <div className="flex items-center gap-1 border border-slate-200 rounded-full px-1 py-1 bg-white">
        <button
          onClick={handleZoomOut}
          disabled={zoomLevel <= 50}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Minus className="w-3 h-3 text-slate-600" />
        </button>
        
        <span className="text-sm font-medium text-slate-700 px-2 min-w-[45px] text-center">
          {zoomLevel}%
        </span>
        
        <button
          onClick={handleZoomIn}
          disabled={zoomLevel >= 200}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3 h-3 text-slate-600" />
        </button>
      </div>
    </div>
  )
}

export default ActionBar
