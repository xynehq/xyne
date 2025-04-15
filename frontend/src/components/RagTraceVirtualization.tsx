import { useState, useMemo, useEffect } from 'react';
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
  Activity
} from 'lucide-react';

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
  [key: string]: any;
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

interface SafeSpan extends TraceSpan {
  children?: SafeSpan[];
}

const fetchChatTrace = async (chatId: string, messageId: string): Promise<TraceJson> => {
  try {
    const res = await api.chat.trace.$get({
      query: { chatId, messageId },
    });
    if (!res.ok) throw new Error("Error fetching chat trace");
    return await res.json();
  } catch (error) {
    console.error("Error fetching chat trace:", error);
    throw error;
  }
};

const parseTraceJson = (data: any): any => {
  if (!data) return { spans: [] };
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error("Failed to parse trace JSON:", e);
      return { spans: [] };
    }
  }
  return data;
};

const safeCalculateDuration = (spans: SafeSpan[]): number => {
  if (!spans || !Array.isArray(spans) || spans.length === 0) return 0;
  try {
    const validSpans = spans.filter(s => s && s.startTime != null && s.endTime != null);
    if (validSpans.length === 0) return 0;
    const endTimes = validSpans.map(s => Number(s.endTime));
    const startTimes = validSpans.map(s => Number(s.startTime));
    return Math.max(...endTimes) - Math.min(...startTimes);
  } catch (error) {
    console.error('Error calculating duration:', error);
    return 0;
  }
};

const formatDuration = (duration: number | null | undefined): string => {
  if (duration == null || isNaN(duration)) return 'N/A';
  return `${duration.toFixed(2)}ms`;
};

const safeTimelineCalculation = (spans: SafeSpan[]) => {
  if (!spans || !Array.isArray(spans) || spans.length === 0) return null;
  try {
    const validSpans = spans.filter(span => span && span.startTime != null);
    if (validSpans.length === 0) return null;
    const startTimes = validSpans.map(s => Number(s.startTime));
    const endTimes = validSpans.filter(s => s.endTime != null).map(s => Number(s.endTime));
    const minTime = Math.min(...startTimes);
    const maxTime = endTimes.length > 0 ? Math.max(...endTimes) : Date.now();
    return { minTime, maxTime, totalDuration: maxTime - minTime };
  } catch (error) {
    console.error('Error in timeline calculation:', error);
    return null;
  }
};

const validateSpanData = (span: SafeSpan): boolean => {
  return Boolean(span && typeof span.startTime === 'number' && !isNaN(span.startTime));
};

export function RagTraceVirtualization({ chatId, messageId, onClose }: RagTraceVirtualizationProps) {
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [expandedSpans, setExpandedSpans] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"hierarchy" | "timeline" | "json">("hierarchy");
  const [darkMode, setDarkMode] = useState(true);

  const { data: rawTraceData, isLoading, error } = useQuery({
    queryKey: ["traceData", chatId, messageId],
    queryFn: () => fetchChatTrace(chatId, messageId),
    enabled: !!chatId && !!messageId,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  const traceData = useMemo(() => {
    if (!rawTraceData) return null;
    let parsedData = rawTraceData.traceJson ? parseTraceJson(rawTraceData.traceJson) : parseTraceJson(rawTraceData);
    let spans: SafeSpan[] = Array.isArray(parsedData?.spans) ? parsedData.spans :
                           typeof parsedData?.spans === 'object' ? Object.values(parsedData.spans) :
                           Array.isArray(parsedData) ? parsedData : [];
    const normalizedSpans = spans.map((span: any) => ({
      ...span,
      spanId: span.spanId || span.id || span.name || `span-${Math.random().toString(36).substr(2, 9)}`,
      parentSpanId: span.parentSpanId || span.parentId || null,
      name: span.name || span.spanId || 'Unnamed Span',
      startTime: span.startTime != null ? Number(span.startTime) : null,
      endTime: span.endTime != null ? Number(span.endTime) : null,
      duration: span.duration != null ? Number(span.duration) :
               (span.startTime != null && span.endTime != null ? Number(span.endTime) - Number(span.startTime) : null),
      attributes: span.attributes || {},
      events: span.events || [],
    }));
    return {
      ...parsedData,
      spans: normalizedSpans,
      traceId: parsedData.traceId || normalizedSpans[0]?.traceId || rawTraceData.id || 'unknown'
    };
  }, [rawTraceData]);

  useEffect(() => {
    if (hierarchy && hierarchy.length > 0) {
      const rootSpanIds = hierarchy.map(span => span.spanId);
      const initialExpandedState: Record<string, boolean> = {};
      rootSpanIds.forEach(id => {
        initialExpandedState[id!] = true;
      });
      setExpandedSpans(prev => ({ ...prev, ...initialExpandedState }));
    }
  }, [traceData]);

  const hierarchy = useMemo(() => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) return [];
    const spanMap = new Map<string, SafeSpan>();
    const rootSpans: SafeSpan[] = [];
    traceData.spans.forEach((span: SafeSpan) => {
      if (!span?.spanId) return;
      spanMap.set(span.spanId, { ...span, children: [] });
    });
    traceData.spans.forEach((span: SafeSpan) => {
      if (!span?.spanId) return;
      const spanWithChildren = spanMap.get(span.spanId)!;
      if (!span.parentSpanId) {
        rootSpans.push(spanWithChildren);
      } else {
        const parent = spanMap.get(span.parentSpanId);
        if (parent) {
          parent.children = parent.children || [];
          parent.children.push(spanWithChildren);
        } else {
          rootSpans.push(spanWithChildren);
        }
      }
    });
    return rootSpans.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  }, [traceData]);

  const filteredHierarchy = useMemo(() => {
    if (!searchQuery.trim() || !hierarchy) return hierarchy;
    const matchesSearch = (span: SafeSpan): boolean => {
      if (!span) return false;
      const queryLower = searchQuery.toLowerCase();
      const spanMatches = 
        (span.name?.toLowerCase().includes(queryLower)) ||
        (span.spanId?.toLowerCase().includes(queryLower)) ||
        (span.attributes && Object.entries(span.attributes).some(([key, value]) => 
          key.toLowerCase().includes(queryLower) || String(value).toLowerCase().includes(queryLower)
        )) ||
        (span.events && span.events.some(event => JSON.stringify(event).toLowerCase().includes(queryLower)));
      return spanMatches || (span.children?.some(matchesSearch) ?? false);
    };
    const filterWithParents = (spans: SafeSpan[]): SafeSpan[] => {
      return spans.reduce((acc: SafeSpan[], span: SafeSpan) => {
        if (matchesSearch(span)) {
          acc.push({
            ...span,
            children: span.children ? filterWithParents(span.children) : []
          });
        } else if (span.children?.some(matchesSearch)) {
          acc.push({
            ...span,
            children: span.children ? filterWithParents(span.children) : []
          });
        }
        return acc;
      }, []);
    };
    return filterWithParents(hierarchy);
  }, [hierarchy, searchQuery]);

  const toggleExpand = (spanId: string) => {
    setExpandedSpans(prev => ({
      ...prev,
      [spanId]: !prev[spanId]
    }));
  };

  const toggleSelected = (spanId: string) => {
    setSelectedSpanIds(prev => 
      prev.includes(spanId) ? prev.filter(id => id !== spanId) : [spanId]
    );
  };

  const getSpanStatus = (span: SafeSpan) => {
    if (!span) return 'unknown';
    if (span.endTime == null) return 'pending';
    return 'completed';
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="text-green-500" size={16} />;
      case 'pending': return <Clock className="text-yellow-500" size={16} />;
      case 'error': return <XCircle className="text-red-500" size={16} />;
      default: return <AlertCircle className="text-gray-500" size={16} />;
    }
  };

  const renderSpanTree = (span: SafeSpan, depth: number = 0) => {
    if (!span) return null;
    const spanId = span.spanId || 'unknown';
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
          onClick={() => toggleSelected(spanId)}
        >
          {hasChildren && (
            <button 
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(spanId);
              }}
              className="mr-1 flex items-center justify-center w-5 h-5"
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}
          {!hasChildren && <div className="w-5 h-5 mr-1" />}
          <div className="flex flex-1 items-center">
            {getStatusIcon(status)}
            <span className="ml-2 font-medium">{span.name || spanId}</span>
            {span.duration != null && (
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {formatDuration(span.duration)}
              </span>
            )}
          </div>
        </div>
        {isExpanded && hasChildren && (
          <div className="ml-2">
            {span.children!.map((child: SafeSpan) => renderSpanTree(child, depth + 1))}
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
              {span.startTime != null && (
                <>
                  <div className="font-medium">Start:</div>
                  <div>{new Date(span.startTime).toLocaleString()}</div>
                </>
              )}
              {span.endTime != null && (
                <>
                  <div className="font-medium">End:</div>
                  <div>{new Date(span.endTime).toLocaleString()}</div>
                </>
              )}
              {span.duration != null && (
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
          </div>
        )}
      </div>
    );
  };

  const getSelectedSpanDetails = (spans: SafeSpan[], selectedId: string): SafeSpan | undefined => {
    return spans.find(span => span.spanId === selectedId);
  };

  const renderSpanDetails = (span: SafeSpan) => {
    if (!span) return null;
    
    return (
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="font-medium">ID:</div>
        <div className="font-mono">{span.spanId}</div>
        {span.parentSpanId && (
          <>
            <div className="font-medium">Parent:</div>
            <div className="font-mono">{span.parentSpanId}</div>
          </>
        )}
        {span.startTime != null && (
          <>
            <div className="font-medium">Start:</div>
            <div>{new Date(span.startTime).toLocaleString()}</div>
          </>
        )}
        {span.endTime != null && (
          <>
            <div className="font-medium">End:</div>
            <div>{new Date(span.endTime).toLocaleString()}</div>
          </>
        )}
        {span.duration != null && (
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
        {span.attributes && Object.keys(span.attributes).length > 0 && (
          <div className="col-span-2 mt-2">
            <h5 className="font-bold text-sm mb-1">Attributes</h5>
            <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-48 overflow-y-auto">
              <pre className="text-sm whitespace-pre-wrap">
                {JSON.stringify(span.attributes, null, 2)}
              </pre>
            </div>
          </div>
        )}
        {span.events && span.events.length > 0 && (
          <div className="col-span-2 mt-2">
            <h5 className="font-bold text-sm mb-1">Events ({span.events.length})</h5>
            <div className="bg-white dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 max-h-48 overflow-y-auto">
              <pre className="text-sm whitespace-pre-wrap">
                {JSON.stringify(span.events, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderTimeline = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) {
      return <div className="p-4 text-center text-gray-500">No spans available for timeline visualization</div>;
    }

    const validSpans = traceData.spans.filter(validateSpanData);
    if (validSpans.length === 0) {
      return <div className="p-4 text-center text-gray-500">No valid spans available for visualization</div>;
    }

    const timelineData = safeTimelineCalculation(validSpans);
    if (!timelineData) {
      return <div className="p-4 text-center text-gray-500">Could not calculate timeline data</div>;
    }

    const { minTime, totalDuration } = timelineData;
    const sortedSpans = [...validSpans].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

    return (
      <div className="w-full p-4">
        <div className="mb-4 text-sm text-gray-600 dark:text-gray-300 pb-3 border-b border-gray-200 dark:border-gray-700">
          Total Duration: {formatDuration(totalDuration)}
        </div>
        <div className="relative w-full mt-8">
          {sortedSpans.map((span) => {
            const spanId = span.spanId || 'unknown';
            const startOffset = ((Number(span.startTime) - minTime) / totalDuration) * 100;
            const duration = span.duration || (span.endTime ? Number(span.endTime) - Number(span.startTime) : 0);
            const durationPercent = Math.max(0.5, (duration / totalDuration) * 100);

            return (
              <div key={spanId} className="flex items-center mb-4 group">
                <div 
                  className="w-56 pr-6 text-sm font-medium text-gray-700 dark:text-gray-300 truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                  onClick={() => toggleSelected(spanId)}
                >
                  {span.name || spanId}
                </div>
                <div className="flex-1 relative h-8">
                  <div className="absolute inset-0 bg-gray-100 dark:bg-gray-800 rounded" />
                  <div
                    className={`absolute h-5 top-1.5 ${
                      getSpanStatus(span) === 'completed' ? 'bg-blue-500' :
                      getSpanStatus(span) === 'pending' ? 'bg-yellow-500' : 'bg-gray-500'
                    } hover:opacity-90 cursor-pointer rounded bg-700`}
                    style={{
                      left: `${Math.max(0, Math.min(100, startOffset))}%`,
                      width: `${Math.min(100, durationPercent)}%`
                    }}
                    onClick={() => toggleSelected(spanId)}
                    title={`${span.name || spanId}\nStart: ${new Date(span.startTime).toLocaleString()}\nDuration: ${formatDuration(span.duration)}`}
                  />
                </div>
                <div className="w-32 pl-6 text-sm text-gray-500 dark:text-gray-400">
                  {formatDuration(duration)}
                </div>
              </div>
            );
          })}
        </div>

        {selectedSpanIds.length > 0 && (
          <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            {(() => {
              const selectedSpan = getSelectedSpanDetails(validSpans, selectedSpanIds[0]);
              return selectedSpan ? (
                <>
                  <h4 className="font-bold text-sm mb-2">{selectedSpan.name || 'Span Details'}</h4>
                  {renderSpanDetails(selectedSpan)}
                </>
              ) : null;
            })()}
          </div>
        )}
      </div>
    );
  };

  const renderJsonView = () => {
    if (!rawTraceData) return <div className="p-6 text-center text-gray-500">No trace data available</div>;
    return (
      <div className="w-full overflow-auto bg-gray-50 dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
        <pre className="text-sm whitespace-pre-wrap font-mono">
          {JSON.stringify(rawTraceData, null, 2)}
        </pre>
      </div>
    );
  };

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const getFooterDuration = () => {
    if (!traceData?.spans || !Array.isArray(traceData.spans)) return 'N/A';
    try {
      const duration = safeCalculateDuration(traceData.spans);
      return formatDuration(duration);
    } catch {
      return 'N/A';
    }
  };

  const getSpanCount = () => {
    return traceData?.spans && Array.isArray(traceData.spans) ? traceData.spans.length : 0;
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    return () => document.documentElement.classList.remove('dark');
  }, [darkMode]);

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex-1 flex items-center justify-center text-red-500">
          <AlertCircle size={24} className="mr-2" />
          <span>Error loading trace data: {error instanceof Error ? error.message : 'Unknown error'}</span>
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'hierarchy' && Array.isArray(filteredHierarchy) && (
          filteredHierarchy.length > 0 ? (
            filteredHierarchy.map(span => renderSpanTree(span))
          ) : (
            <div className="p-4 text-center text-gray-500">
              <AlertCircle size={24} className="mx-auto mb-2 text-yellow-500" />
              <p>No spans available or matching your search criteria</p>
            </div>
          )
        )}
        {activeTab === 'timeline' && renderTimeline()}
        {activeTab === 'json' && renderJsonView()}
      </div>
    );
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        <div className="w-full h-full flex flex-col shadow-lg border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center">
              <Activity size={24} className="mr-2 text-blue-600 dark:text-blue-400" />
              <h2 className="font-bold text-lg">
                Trace Explorer: {traceData?.traceId || rawTraceData?.chatId || 'Loading...'}
              </h2>
            </div>
            <div className="flex items-center space-x-2">
              <button
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={toggleDarkMode}
                title="Toggle dark mode"
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              <button
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={onClose}
                title="Close"
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div className="border-b border-gray-200 dark:border-gray-700 p-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search size={16} className="text-gray-400" />
              </div>
              <input
                type="text"
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-sm placeholder-gray-400"
                placeholder="Search spans, attributes, events..."
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
          <div className="flex-1 flex overflow-hidden">
            {renderContent()}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-700 p-2 text-sm text-gray-500 dark:text-gray-400 flex justify-between">
            <div>
              {traceData ? `${getSpanCount()} spans` : 'No data'}
            </div>
            <div>
              {traceData && traceData.spans && traceData.spans.length > 0 && (
                <>Total Duration: {getFooterDuration()}</>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}