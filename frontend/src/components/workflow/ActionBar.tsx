import React from 'react';

interface ActionBarProps {
  onExecute?: () => void;
  zoomLevel?: number;
  onZoomChange?: (zoom: number) => void;
}

const ActionBar: React.FC<ActionBarProps> = ({ 
  onExecute, 
  zoomLevel = 100, 
  onZoomChange 
}) => {
  const handleZoomChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newZoom = parseInt(e.target.value, 10);
    if (onZoomChange) {
      onZoomChange(newZoom);
    }
  };

  return (
    <div className="flex items-center gap-2 bg-white p-1.5 rounded-lg shadow-sm border border-blue-100 border-dashed">
      <button
        onClick={onExecute}
        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white border-none rounded-md cursor-pointer text-sm font-medium flex items-center gap-1.5 transition-all duration-200"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        Execute Node
      </button>
      
      <div className="flex items-center gap-1 border border-slate-200 rounded-md px-2 py-1.5 bg-white">
        <svg className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <select 
          className="border-none bg-transparent text-sm font-medium text-slate-700 cursor-pointer appearance-none pr-4 outline-none"
          value={zoomLevel}
          onChange={handleZoomChange}
        >
          <option value="50">50%</option>
          <option value="75">75%</option>
          <option value="100">100%</option>
          <option value="125">125%</option>
          <option value="150">150%</option>
        </select>
        <svg className="w-4 h-4 text-slate-500 ml-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
    </div>
  );
};

export default ActionBar;
