import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import {
  Search,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  Moon,
  Sun,
  ChevronRight,
  ChevronDown,
  Code,
  X,
  Layers,
  BarChart2,
  Activity,
  Maximize2,
  Minimize2,
  Eye,
  EyeOff
} from 'lucide-react';

// Define types for trace data based on the actual structure in the screenshot
interface TraceSpan {
  attributes?: Record<string, any>;
  duration?: number;
  endTime?: number;
  events?: any[];
  name?: string;
  parentSpanId?: string | null;
  spanId?: string;
  startTime?: number;
  traceId?: string;
  [prototype]?: string;
  constructor?: any;
  length?: number;
}

interface TraceJson {
  id?: string | number;
  chatId?: string | number;
  workspaceId?: string | number;
  userId?: string | number;
  chatInternalId?: string;
  createdAt?: string;
  email?: string;
  messageExternalId?: string;
  messageId?: string | number;
  traceJson?: {
    spans?: TraceSpan[];
    [key: string]: any;
  };
  [key: string]: any;
}

interface RagTraceVirtualizationProps {
  chatId: string;
  messageId: string;
  onClose: () => void;
}

// Function to fetch chat trace data from the API
const fetchChatTrace = async (chatId: string, messageId: string): Promise<TraceJson> => {
  const res = await api.chat.trace.$get({
    query: { chatId, messageId },
  });
  if (!res.ok) throw new Error("Error fetching chat trace");
  return res.json();
};

// Parse trace data from string if needed
const parseTraceJson = (data: any): any => {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error("Failed to parse trace JSON:", e);
      return data;
    }
  }
  return data;
};

export function RagTraceVirtualization({ chatId, messageId, onClose }: RagTraceVirtualizationProps) {
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [expandedSpans, setExpandedSpans] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"hierarchy" | "timeline" | "json">("hierarchy");
  const [darkMode, setDarkMode] = useState(true); // Default to dark mode to match the screenshot
  const [fullScreen, setFullScreen] = useState(false);
  const [showPrototype, setShowPrototype] = useState(false);

  // Fetch trace data from the API using React Query
  const { data: rawTraceData, isLoading, error } = useQuery({
    queryKey: ["traceData", chatId, messageId],
    queryFn: () => fetchChatTrace(chatId, messageId),
    enabled: !!chatId && !!messageId,
  });

  // Process and normalize trace data
  const traceData = useMemo(() => {
    if (!rawTraceData) return null;
    
    // Parse trace JSON if it's a string
    const parsedTraceJson = parseTraceJson(rawTraceData.traceJson || rawTraceData);
    
    // Extract spans array from the appropriate location
    let spans = parsedTraceJson?.spans || [];
    
    // If spans is not an array but an object with numeric keys, convert to array
    if (!Array.isArray(spans) && typeof spans === 'object') {
      spans = Object.values(spans);
    }
    
    return {
      ...parsedTraceJson,
      spans: spans.map((span: any) => ({
        ...span,
        spanId: span.spanId || span.name,
        parentSpanId: span.parentSpanId || null
      }))
    };
  }, [rawTraceData]);

  // Build span hierarchy
  const hierarchy = useMemo(() => {
    if (!traceData || !traceData.spans) return [];

    const spanMap = new Map<string, any & { children: any[] }>();
    const rootSpans: any[] = [];

    // First pass: map all spans by ID
    traceData.spans.forEach((span: any) => {
      const spanId = span.spanId || span.name;
      if (!spanId) return;
      
      spanMap.set(spanId, { ...span, children: [] });
    });

    // Second pass: build the hierarchy
    traceData.spans.forEach((span: any) => {
      const spanId = span.spanId || span.name;
      if (!spanId) return;
      
      const spanWithChildren = spanMap.get(spanId)!;
      
      if (!span.parentSpanId) {
        rootSpans.push(spanWithChildren);
      } else {
        const parent = spanMap.get(span.parentSpanId);
        if (parent) {
          parent.children.push(spanWithChildren);
        } else {
          // Parent not found, add to root
          rootSpans.push(spanWithChildren);
        }
      }
    });

    return rootSpans;
  }, [traceData]);

  // Filter spans based on search query
  const filteredHierarchy = useMemo(() => {
    if (!searchQuery.trim() || !hierarchy) return hierarchy;

    // Function to recursively check if span or any of its descendants match
    const matchesSearch = (span: any): boolean => {
      const spanMatches = 
        (span.name && span.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (span.spanId && span.spanId.toLowerCase().includes(searchQuery.toLowerCase())) ||
        Object.entries(span.attributes || {}).some(([key, value]) => 
          key.toLowerCase().includes(searchQuery.toLowerCase()) || 
          String(value).toLowerCase().includes(searchQuery.toLowerCase())
        );

      if (spanMatches) return true;
      return (span.children || []).some((child: any) => matchesSearch(child));
    };

    // Keep only spans that match or have descendants that match
    return hierarchy.filter(matchesSearch);
  }, [hierarchy, searchQuery]);

  // Format duration in ms
  const formatDuration = (duration: number | null | undefined): string => {
    if (duration === null || duration === undefined) return 'N/A';
    if (duration < 1000) return `${duration.toFixed(2)}ms`;
    return `${(duration / 1000).toFixed(2)}s`;
  };

  // Format timestamp
  const formatTimestamp = (timestamp: number | undefined): string => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleTimeString();
  };

  // Toggle expand/collapse for a span
  const toggleExpand = (spanId: string) => {
    setExpandedSpans(prev => ({
      ...prev,
      [spanId]: !prev[spanId]
    }));
  };

  // Toggle selected span
  const toggleSelected = (spanId: string) => {
    setSelectedSpanIds(prev => 
      prev.includes(spanId) 
        ? prev.filter(id => id !== spanId)
        : [...prev, spanId]
    );
  };

  // Get span status
  const getSpanStatus = (span: any) => {
    if (!span.endTime) return 'pending';
    if (span.duration === undefined || span.duration === null) return 'unknown';
    return 'completed';
  };

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="text-green-500" size={16} />;
      case 'pending': return <Clock className="text-yellow-500" size={16} />;
      case 'error': return <XCircle className="text-red-500" size={16} />;
      default: return <AlertCircle className="text-gray-500" size={16} />;
    }
  };

  // Determine if a value should be displayed or hidden based on prototype visibility
  const shouldDisplayProperty = (key: string) => {
    return showPrototype || !key.startsWith('[prototype]');
  };

  // Format a value for display, handling various types
  const formatValue = (value: any): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return 'ƒ()';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return '[Complex Object]';
      }
    }
    return String(value);
  };

  // Recursive rendering function for span hierarchy
  const renderSpanTree = (span: any, depth: number = 0) => {
    if (!span) return null;
    
    const spanId = span.spanId || span.name || 'unknown';
    const isExpanded = expandedSpans[spanId] || false;
    const isSelected = selectedSpanIds.includes(spanId);
    const status = getSpanStatus(span);
    const hasChildren = span.children && span.children.length > 0;
    
    return (
      <div key={spanId} className="w-full">
        <div 
          className={`flex items-center p-2 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors ${
            isSelected ? 'bg-blue-50 dark:bg-blue-900/30' : ''
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren && (
            <button 
              onClick={() => toggleExpand(spanId)}
              className="mr-1 flex items-center justify-center w-5 h-5"
            >
              {isExpanded ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
          )}
          {!hasChildren && <div className="w-5 h-5 mr-1" />}
          
          <div 
            className="flex flex-1 items-center"
            onClick={() => toggleSelected(spanId)}
          >
            {getStatusIcon(status)}
            <span className="ml-2 font-medium">{span.name || spanId}</span>
            {span.duration !== undefined && (
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {formatDuration(span.duration)}
              </span>
            )}
          </div>
        </div>
        
        {isExpanded && hasChildren && (
          <div className="ml-2">
            {span.children.map((child: any) => renderSpanTree(child, depth + 1))}
          </div>
        )}
        
        {isSelected && (
          <div className="border-l-2 border-blue-500 ml-6 pl-4 py-2 mb-2 bg-gray-50 dark:bg-gray-800/50">
            <h4 className="font-bold text-sm mb-2">Span Details</h4>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <div className="font-medium">ID:</div>
              <div className="font-mono">{spanId}</div>
              {span.parentSpanId && (
                <>
                  <div className="font-medium">Parent:</div>
                  <div className="font-mono">{span.parentSpanId}</div>
                </>
              )}
              {span.startTime && (
                <>
                  <div className="font-medium">Start:</div>
                  <div>{formatTimestamp(span.startTime)}</div>
                </>
              )}
              {span.endTime && (
                <>
                  <div className="font-medium">End:</div>
                  <div>{formatTimestamp(span.endTime)}</div>
                </>
              )}
              {span.duration !== undefined && (
                <>
                  <div className="font-medium">Duration:</div>
                  <div>{formatDuration(span.duration)}</div>
                </>
              )}
              {span.traceId && (
                <>
                  <div className="font-medium">Trace ID:</div>
                  <div className="font-mono truncate">{span.traceId}</div>
                </>
              )}
            </div>
            
            {span.attributes && Object.keys(span.attributes).length > 0 && (
              <div className="mt-3">
                <h5 className="font-bold text-xs mb-1">Attributes</h5>
                <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-40 overflow-y-auto">
                  <pre className="text-xs whitespace-pre-wrap">
                    {JSON.stringify(span.attributes, null, 2)}
                  </pre>
                </div>
              </div>
            )}
            
            {span.events && span.events.length > 0 && (
              <div className="mt-3">
                <h5 className="font-bold text-xs mb-1">Events ({span.events.length})</h5>
                <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-40 overflow-y-auto">
                  <pre className="text-xs whitespace-pre-wrap">
                    {JSON.stringify(span.events, null, 2)}
                  </pre>
                </div>
              </div>
            )}
            
            {/* Display all other properties */}
            <div className="mt-3">
              <h5 className="font-bold text-xs mb-1">All Properties</h5>
              <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-60 overflow-y-auto">
                <div className="grid grid-cols-1 gap-1 text-xs">
                  {Object.entries(span)
                    .filter(([key]) => key !== 'children' && shouldDisplayProperty(key))
                    .map(([key, value]) => (
                      <div key={key} className="grid grid-cols-2 border-b border-gray-100 dark:border-gray-800 py-1">
                        <div className="font-medium">{key}:</div>
                        <div className="font-mono overflow-x-auto whitespace-nowrap">
                          {formatValue(value)}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Timeline visualization
  const renderTimeline = () => {
    if (!traceData || !traceData.spans || !traceData.spans.length) return null;
    
    // Find the earliest and latest timestamps
    const spansWithTimes = traceData.spans.filter(span => span.startTime);
    if (!spansWithTimes.length) return <div className="p-4">No timeline data available</div>;
    
    const minTime = Math.min(...spansWithTimes.map(span => span.startTime!));
    const maxTime = Math.max(...spansWithTimes
      .map(span => span.endTime || Date.now()));
    const totalDuration = maxTime - minTime;
    
    return (
      <div className="w-full overflow-x-auto">
        <div className="py-2 min-w-full">
          {spansWithTimes.map(span => {
            const spanId = span.spanId || span.name || 'unknown';
            const startOffset = ((span.startTime! - minTime) / totalDuration) * 100;
            const duration = span.endTime 
              ? ((span.endTime - span.startTime!) / totalDuration) * 100
              : ((Date.now() - span.startTime!) / totalDuration) * 100;
            const status = getSpanStatus(span);
            
            return (
              <div key={spanId} className="flex items-center mb-2">
                <div className="w-48 pr-2 text-xs truncate">
                  {span.name || spanId}
                </div>
                <div className="flex-1 relative h-6">
                  <div className="absolute left-0 right-0 h-1 bg-gray-200 dark:bg-gray-700 top-1/2 transform -translate-y-1/2" />
                  <div 
                    className={`absolute h-6 rounded ${
                      status === 'completed' ? 'bg-blue-500' : 
                      status === 'pending' ? 'bg-yellow-500' : 'bg-gray-500'
                    } opacity-80`}
                    style={{ 
                      left: `${startOffset}%`, 
                      width: `${Math.max(0.5, duration)}%` 
                    }}
                    onClick={() => toggleSelected(spanId)}
                    title={`${span.name || spanId} (${formatDuration(span.duration)})`}
                  />
                </div>
                <div className="w-24 pl-2 text-xs">
                  {formatDuration(span.duration)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Raw JSON view
  const renderJsonView = () => {
    if (!rawTraceData) return null;
    
    return (
      <div className="w-full overflow-auto bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700">
        <pre className="text-xs whitespace-pre-wrap">
          {JSON.stringify(rawTraceData, null, 2)}
        </pre>
      </div>
    );
  };

  // Toggle dark mode
  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  // Toggle fullscreen
  const toggleFullScreen = () => {
    setFullScreen(!fullScreen);
  };
  
  // Toggle prototype property visibility
  const togglePrototypeVisibility = () => {
    setShowPrototype(!showPrototype);
  };

  return (
    <div 
      className={`${darkMode ? 'dark' : ''} ${
        fullScreen ? 'fixed inset-0 z-50' : 'relative'
      }`}
    >
      <div className="w-full h-full flex flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-lg border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center">
            <Activity size={20} className="mr-2 text-blue-600 dark:text-blue-400" />
            <h2 className="font-bold">
              Trace Explorer: {traceData?.traceId || rawTraceData?.chatId || 'Loading...'}
            </h2>
          </div>
          <div className="flex items-center space-x-2">
            <button
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center"
              onClick={togglePrototypeVisibility}
              title="Toggle prototype properties"
            >
              {showPrototype ? <EyeOff size={18} /> : <Eye size={18} />}
              <span className="ml-1 text-xs">Prototype</span>
            </button>
            <button
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={toggleDarkMode}
              title="Toggle dark mode"
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={toggleFullScreen}
              title="Toggle fullscreen"
            >
              {fullScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button
              className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={onClose}
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Search bar and tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700 p-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex-1 relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search size={16} className="text-gray-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-sm"
              placeholder="Search spans, attributes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex space-x-1">
            <button
              className={`px-3 py-1 rounded-md text-sm flex items-center ${
                activeTab === 'hierarchy' 
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200' 
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              onClick={() => setActiveTab('hierarchy')}
            >
              <Layers size={16} className="mr-1" />
              Hierarchy
            </button>
            <button
              className={`px-3 py-1 rounded-md text-sm flex items-center ${
                activeTab === 'timeline' 
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200' 
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              onClick={() => setActiveTab('timeline')}
            >
              <BarChart2 size={16} className="mr-1" />
              Timeline
            </button>
            <button
              className={`px-3 py-1 rounded-md text-sm flex items-center ${
                activeTab === 'json' 
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200' 
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              onClick={() => setActiveTab('json')}
            >
              <Code size={16} className="mr-1" />
              JSON
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-red-500">
              <AlertCircle size={20} className="mr-2" />
              <span>Error loading trace data</span>
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-2">
              {activeTab === 'hierarchy' && filteredHierarchy?.map(span => renderSpanTree(span))}
              {activeTab === 'timeline' && renderTimeline()}
              {activeTab === 'json' && renderJsonView()}
              {activeTab === 'hierarchy' && (!filteredHierarchy || filteredHierarchy.length === 0) && (
                <div className="p-4 text-center">
                  <AlertCircle size={24} className="mx-auto mb-2 text-yellow-500" />
                  <p>No spans available or matching your search criteria</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer with stats */}
        <div className="border-t border-gray-200 dark:border-gray-700 p-2 text-xs text-gray-500 dark:text-gray-400 flex justify-between">
          <div>
            {traceData ? `${traceData.spans?.length || 0} spans` : 'No data'}
          </div>
          <div>
            {traceData && traceData.spans && traceData.spans.length > 0 && (
              <>
                {traceData.spans.some(s => s.duration !== undefined) && (
                  <>
                    Total Duration: {formatDuration(
                      Math.max(...traceData.spans
                        .filter(s => s.endTime)
                        .map(s => s.endTime!)) - 
                      Math.min(...traceData.spans
                        .filter(s => s.startTime)
                        .map(s => s.startTime!))
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}