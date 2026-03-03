import React, { useEffect, useState, useMemo, memo, useCallback, useRef } from 'react';

// Loading Component
const LoadingSpinner: React.FC = () => (
  <div className='flex items-center justify-center h-full min-h-[200px]'>
    <div className='text-center'>
      <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3'></div>
      <p className='text-gray-600 dark:text-gray-300 text-sm'>Loading JSON file...</p>
    </div>
  </div>
);

// Error Component
const ErrorDisplay: React.FC<{ error: string; canRetry?: boolean; onRetry?: () => void }> = ({
  error,
  canRetry = false,
  onRetry,
}) => (
  <div className='flex items-center justify-center h-full min-h-[200px]'>
    <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 max-w-md text-center'>
      <p className='text-red-800 dark:text-red-200 font-semibold mb-2'>Unable to display JSON</p>
      <p className='text-red-600 dark:text-red-300 text-sm mb-3'>{error}</p>
      {canRetry && onRetry && (
        <button
          onClick={onRetry}
          className='px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors'
          data-track-category='FileViewer'
          data-track-name='RETRY_LOAD_JSON'
        >
          Try Again
        </button>
      )}
    </div>
  </div>
);

interface JsonViewerProps {
  source: File | Blob | null;
  className?: string;
  style?: React.CSSProperties;
}

const JsonViewer: React.FC<JsonViewerProps> = memo(({ source, className, style }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isValidJson, setIsValidJson] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate file size for display
  const fileSizeMB = useMemo(() => {
    return source ? source.size / (1024 * 1024) : 0;
  }, [source]);

  const loadFile = useCallback(async (): Promise<void> => {
    if (!source) {
      setError('No file source provided');
      setLines([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setIsValidJson(true);

    try {
      const reader = new FileReader();

      const readPromise = new Promise<string>((resolve, reject) => {
        reader.onload = (e: ProgressEvent<FileReader>): void => {
          const result = e.target?.result;
          if (typeof result === 'string') {
            resolve(result);
          } else {
            reject(new Error('Failed to read file as text'));
          }
        };

        reader.onerror = (): void => {
          reject(new Error('File reading failed - file may be corrupted'));
        };

        reader.onabort = (): void => {
          reject(new Error('File reading was aborted'));
        };
      });

      // Start reading the file
      if (typeof source === 'string') {
        reader.readAsText(new Blob([source]), 'UTF-8');
      } else {
        reader.readAsText(source, 'UTF-8');
      }

      const text = await readPromise;

      if (!text) {
        throw new Error('File is empty or contains no readable content');
      }

      // Try to parse and format JSON
      try {
        const parsed = JSON.parse(text) as unknown;
        const formatted = JSON.stringify(parsed, null, 2);
        // Split into lines for virtualization
        const allLines = formatted.split(/\r?\n/);
        setLines(allLines);
      } catch {
        // If not valid JSON, display as-is but mark as invalid
        const allLines = text.split(/\r?\n/);
        setLines(allLines);
        setIsValidJson(false);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown error occurred while reading file';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const handleRetry = (): void => {
    void loadFile();
  };

  // Render loading state
  if (loading) {
    return (
      <div className='relative h-full bg-white dark:bg-[#1E1E1E]'>
        <LoadingSpinner />
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className='relative h-full bg-white dark:bg-[#1E1E1E]'>
        <ErrorDisplay error={error} canRetry onRetry={handleRetry} />
      </div>
    );
  }

  // Render content
  return (
    <div
      className={`font-mono text-sm bg-white dark:bg-[#1E1E1E] text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded-lg ${className || ''}`}
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {/* Header with file info */}
      <div className='flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 rounded-t-lg flex-shrink-0'>
        <div className='flex items-center gap-2 min-w-0 flex-1'>
          <svg
            className='w-4 h-4 text-gray-500 flex-shrink-0'
            fill='currentColor'
            viewBox='0 0 20 20'
          >
            <path
              fillRule='evenodd'
              d='M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z'
              clipRule='evenodd'
            />
          </svg>
          <span className='text-xs text-gray-600 dark:text-gray-400 truncate'>
            {lines.length.toLocaleString()} lines • {fileSizeMB.toFixed(2)}MB
          </span>
        </div>
        <div className='flex items-center gap-2'>
          {!isValidJson && (
            <span className='text-xs text-yellow-600 dark:text-yellow-400 font-medium'>
              Invalid JSON
            </span>
          )}
        </div>
      </div>

      {/* Content area */}
      <div
        ref={containerRef}
        className='flex-1 overflow-auto p-3'
        style={{
          maxHeight: 'none',
        }}
      >
        <div>
          {lines.map((line, index) => (
            <div key={index} className='flex min-h-[20px]'>
              <span className='text-gray-400 dark:text-gray-600 text-xs w-12 text-right mr-3 flex-shrink-0 select-none'>
                {index + 1}
              </span>
              <span
                className='flex-1 text-xs sm:text-sm'
                style={{
                  wordWrap: 'break-word',
                  overflowWrap: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {line || '\u00A0'} {/* Non-breaking space for empty lines */}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

JsonViewer.displayName = 'JsonViewer';

export default JsonViewer;
