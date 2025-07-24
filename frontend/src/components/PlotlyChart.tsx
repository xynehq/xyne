import React, { useState, useRef, useCallback, useEffect } from "react"
import Plot from "react-plotly.js"
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Download,
  RefreshCw,
  Copy,
} from "lucide-react"
import { toast } from "@/hooks/use-toast"

interface PlotlyChartProps {
  plotlyConfig: string | object
  title?: string
  className?: string
}

export const PlotlyChart: React.FC<PlotlyChartProps> = ({
  plotlyConfig,
  title,
  className = "",
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [containerHeight, setContainerHeight] = useState(400)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [config, setConfig] = useState<any>(null)
  const plotRef = useRef<any>(null)

  // Parse the Plotly configuration
  useEffect(() => {
    try {
      setIsLoading(true)
      setError(null)

      let parsedConfig
      if (typeof plotlyConfig === "string") {
        parsedConfig = JSON.parse(plotlyConfig)
      } else {
        parsedConfig = plotlyConfig
      }

      // Validate the config structure
      if (!parsedConfig.data || !Array.isArray(parsedConfig.data)) {
        throw new Error(
          "Invalid Plotly configuration: missing or invalid data array",
        )
      }

      // Set default responsive layout if not provided
      const defaultLayout = {
        autosize: true,
        margin: { l: 50, r: 50, t: 50, b: 50 },
        font: { family: "Inter, system-ui, sans-serif" },
        ...parsedConfig.layout,
      }

      // Set default config options
      const defaultConfig = {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: [
          "pan2d",
          "lasso2d",
          "select2d",
          "autoScale2d",
          "hoverClosestCartesian",
          "hoverCompareCartesian",
        ],
        ...parsedConfig.config,
      }

      setConfig({
        data: parsedConfig.data,
        layout: defaultLayout,
        config: defaultConfig,
      })

      setIsLoading(false)
    } catch (err) {
      console.error("Error parsing Plotly configuration:", err)
      setError(
        err instanceof Error
          ? err.message
          : "Failed to parse chart configuration",
      )
      setIsLoading(false)
    }
  }, [plotlyConfig])

  const handleFullscreen = () => {
    setIsFullscreen(!isFullscreen)
  }

  const adjustHeight = (delta: number) => {
    setContainerHeight((prev) => Math.max(200, Math.min(800, prev + delta)))
  }

  const downloadChart = useCallback(() => {
    if (plotRef.current && plotRef.current.el) {
      try {
        // Use Plotly's built-in download functionality
        const plotElement = plotRef.current.el
        const plotlyInstance = plotElement._fullLayout ? plotElement : null

        if (plotlyInstance) {
          // Trigger download using Plotly's native method
          const modeBarButtons = plotElement.querySelector(
            '.modebar-btn[data-title="Download plot as a png"]',
          )
          if (modeBarButtons) {
            modeBarButtons.click()
          } else {
            toast({
              title: "Download unavailable",
              description: "Chart download feature is not available",
              variant: "destructive",
            })
          }
        }
      } catch (error) {
        console.error("Error downloading chart:", error)
        toast({
          title: "Download failed",
          description: "Failed to download the chart",
          variant: "destructive",
        })
      }
    }
  }, [])

  const copyConfig = useCallback(() => {
    try {
      const configString =
        typeof plotlyConfig === "string"
          ? plotlyConfig
          : JSON.stringify(plotlyConfig, null, 2)

      navigator.clipboard.writeText(configString)
      toast({
        title: "Copied!",
        description: "Chart configuration copied to clipboard",
      })
    } catch (error) {
      console.error("Error copying config:", error)
      toast({
        title: "Copy failed",
        description: "Failed to copy chart configuration",
        variant: "destructive",
      })
    }
  }, [plotlyConfig])

  const refreshChart = useCallback(() => {
    setIsLoading(true)
    // Force re-render by updating the config
    setTimeout(() => {
      if (plotRef.current && plotRef.current.resizeHandler) {
        plotRef.current.resizeHandler()
      }
      setIsLoading(false)
    }, 100)
  }, [])

  const PlotlyControls = () => {
    const buttonBaseClass =
      "bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-1.5 shadow-md z-10 transition-colors"
    const iconSize = 14

    return (
      <div className="absolute top-2 right-2 flex space-x-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <button
          onClick={refreshChart}
          className={`${buttonBaseClass} rounded-l-md`}
          title="Refresh Chart"
        >
          <RefreshCw size={iconSize} />
        </button>
        <button
          onClick={copyConfig}
          className={`${buttonBaseClass}`}
          title="Copy Configuration"
        >
          <Copy size={iconSize} />
        </button>
        <button
          onClick={downloadChart}
          className={`${buttonBaseClass}`}
          title="Download Chart"
        >
          <Download size={iconSize} />
        </button>
        <button
          onClick={() => adjustHeight(-50)}
          className={`${buttonBaseClass}`}
          title="Decrease Height"
        >
          <ZoomOut size={iconSize} />
        </button>
        <button
          onClick={() => adjustHeight(50)}
          className={`${buttonBaseClass}`}
          title="Increase Height"
        >
          <ZoomIn size={iconSize} />
        </button>
        <button
          onClick={handleFullscreen}
          className={`${buttonBaseClass} rounded-r-md`}
          title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 size={iconSize} />
          ) : (
            <Maximize2 size={iconSize} />
          )}
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div
        className={`relative group border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden ${className}`}
      >
        <div className="p-6 text-center">
          <div className="text-red-500 dark:text-red-400 text-lg font-medium mb-2">
            📊 Chart Error
          </div>
          <div className="text-gray-600 dark:text-gray-400 text-sm">
            {error}
          </div>
          <button
            onClick={refreshChart}
            className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (isLoading || !config) {
    return (
      <div
        className={`relative group border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden ${className}`}
      >
        <div
          className="flex items-center justify-center bg-gray-50 dark:bg-gray-800"
          style={{ height: containerHeight }}
        >
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <div className="text-gray-600 dark:text-gray-400 text-sm">
              Loading chart...
            </div>
          </div>
        </div>
      </div>
    )
  }

  const chartComponent = (
    <div
      className={`relative group border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden ${className}`}
    >
      <PlotlyControls />
      {title && (
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {title}
          </h3>
        </div>
      )}
      <div style={{ height: containerHeight }}>
        <Plot
          ref={plotRef}
          data={config.data}
          layout={config.layout}
          config={config.config}
          style={{ width: "100%", height: "100%" }}
          useResizeHandler={true}
          onError={(error: any) => {
            console.error("Plotly render error:", error)
            setError("Failed to render chart")
          }}
        />
      </div>
    </div>
  )

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 p-4">
        <div className="h-full w-full">{chartComponent}</div>
      </div>
    )
  }

  return chartComponent
}

export default PlotlyChart
