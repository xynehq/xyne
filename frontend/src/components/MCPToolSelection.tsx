import React, { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { api } from "@/api"
import { Gavel, ChevronDown, ChevronRight, Search } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { ConnectorStatus, ConnectorType } from "shared/types"

interface MCPTool {
  externalId: string
  toolName: string
  description?: string
  enabled: boolean
}

interface MCPConnector {
  id: string
  connectorId: number
  externalId: string
  name: string
  status: ConnectorStatus
  type: ConnectorType
  tools: MCPTool[]
}

interface ConnectorResponse {
  id: string
  connectorId: number
  externalId: string
  name: string
  status: ConnectorStatus
  type: ConnectorType
}

interface SelectedMCPTools {
  connectorId: string
  tools: string[]
}

interface MCPToolSelectionProps {
  selectedTools: SelectedMCPTools[]
  onSelectionChange: (tools: SelectedMCPTools[]) => void
  trigger?: React.ReactNode
}

export function MCPToolSelection({
  selectedTools,
  onSelectionChange,
  trigger,
}: MCPToolSelectionProps) {
  const [open, setOpen] = useState(false)
  const [connectors, setConnectors] = useState<MCPConnector[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [loading, setLoading] = useState(false)
  const [expandedConnectors, setExpandedConnectors] = useState<Set<string>>(
    new Set(),
  )
  const { toast } = useToast()

  // Convert selectedTools array to a map for easier lookup
  const selectedToolsMap = new Map<string, Set<string>>()
  selectedTools.forEach((item) => {
    selectedToolsMap.set(item.connectorId, new Set(item.tools))
  })

  useEffect(() => {
    if (open) {
      fetchMCPConnectors()
    }
  }, [open])

  const fetchMCPConnectors = async () => {
    setLoading(true)
    try {
      const response = await api.admin.connectors.all.$get()
      if (response.ok) {
        const data = await response.json()
        // console.log("All connectors:", data)
        
        const mcpConnectors = data.filter(
          (c: ConnectorResponse) => {
            // console.log(`Connector ${c.name}: type=${c.type}, status=${c.status}`)
            return c.type === "Mcp" && c.status === "connected"
          }
        )
        
        console.log("Filtered MCP connectors:", mcpConnectors)

        // Fetch tools for each MCP connector
        const connectorsWithTools = await Promise.all(
          mcpConnectors.map(async (connector: ConnectorResponse) => {
            try {
              // console.log("Connector object:", connector)
              // console.log("Connector id (externalId):", connector.id)
              
              const connectorId = connector.id
              // console.log("Using connectorId:", connectorId)
              
              if (!connectorId) {
                console.error("No valid connector ID found for connector:", connector)
                return {
                  ...connector,
                  tools: [],
                }
              }
              
              const toolsResponse = await api.admin.connector[":connectorId"].tools.$get({
                param: { connectorId: connectorId },
              })
              if (toolsResponse.ok) {
                const toolsData = await toolsResponse.json()
                // console.log(`Tools for ${connector.name}:`, toolsData)
                return {
                  ...connector,
                  tools: toolsData || [],
                }
              }
              return {
                ...connector,
                tools: [],
              }
            } catch (error) {
              const connectorId = connector.externalId || connector.id
              console.error(`Failed to fetch tools for connector ${connectorId}:`, error)
              return {
                ...connector,
                tools: [],
              }
            }
          }),
        )

        setConnectors(connectorsWithTools)
      }
    } catch (error) {
      console.error("Failed to fetch MCP connectors:", error)
      toast({
        title: "Error",
        description: "Failed to fetch MCP connectors",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const filteredConnectors = connectors.filter(
    (connector) =>
      connector.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      connector.tools.some((tool) =>
        tool.toolName.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
  )

  const toggleConnectorExpansion = (connectorId: string) => {
    const newExpanded = new Set(expandedConnectors)
    if (newExpanded.has(connectorId)) {
      newExpanded.delete(connectorId)
    } else {
      newExpanded.add(connectorId)
    }
    setExpandedConnectors(newExpanded)
  }

  const handleToolSelection = (
    connectorId: string,
    toolExternalId: string,
    selected: boolean,
  ) => {
    const newSelectedTools = [...selectedTools]
    const existingConnectorIndex = newSelectedTools.findIndex(
      (item) => item.connectorId === connectorId,
    )

    if (existingConnectorIndex >= 0) {
      const existingTools = new Set(newSelectedTools[existingConnectorIndex].tools)
      if (selected) {
        existingTools.add(toolExternalId)
      } else {
        existingTools.delete(toolExternalId)
      }
      
      if (existingTools.size === 0) {
        newSelectedTools.splice(existingConnectorIndex, 1)
      } else {
        newSelectedTools[existingConnectorIndex].tools = Array.from(existingTools)
      }
    } else if (selected) {
      newSelectedTools.push({
        connectorId,
        tools: [toolExternalId],
      })
    }

    onSelectionChange(newSelectedTools)
  }

  const handleConnectorToggle = (connector: MCPConnector, selectAll: boolean) => {
    const newSelectedTools = [...selectedTools]
    // Use the external ID string, not the numeric database ID
    const connectorId = connector.id
    const existingConnectorIndex = newSelectedTools.findIndex(
      (item) => item.connectorId === connectorId,
    )

    if (selectAll) {
      const allToolIds = connector.tools
        .filter((tool) => tool.enabled)
        .map((tool) => tool.externalId)
      
      if (existingConnectorIndex >= 0) {
        newSelectedTools[existingConnectorIndex].tools = allToolIds
      } else {
        newSelectedTools.push({
          connectorId: connectorId,
          tools: allToolIds,
        })
      }
    } else {
      if (existingConnectorIndex >= 0) {
        newSelectedTools.splice(existingConnectorIndex, 1)
      }
    }

    onSelectionChange(newSelectedTools)
  }

  const getSelectedToolsCount = () => {
    return selectedTools.reduce((total, item) => total + item.tools.length, 0)
  }

  const isConnectorSelected = (connector: MCPConnector) => {
    const connectorId = connector.id
    const connectorTools = selectedToolsMap.get(connectorId)
    if (!connectorTools) return false
    const enabledTools = connector.tools.filter((tool) => tool.enabled)
    return enabledTools.length > 0 && enabledTools.every((tool) => connectorTools.has(tool.externalId))
  }

  const isConnectorPartiallySelected = (connector: MCPConnector) => {
    const connectorId = connector.id
    const connectorTools = selectedToolsMap.get(connectorId)
    if (!connectorTools) return false
    return connector.tools.some((tool) => tool.enabled && connectorTools.has(tool.externalId))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" className="flex items-center gap-2">
            <Gavel size={16} />
            Select MCP Tools
            {getSelectedToolsCount() > 0 && (
              <Badge variant="secondary" className="ml-1">
                {getSelectedToolsCount()}
              </Badge>
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Select MCP Tools for Agent</DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Search connectors and tools..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="text-gray-500">Loading MCP connectors...</div>
              </div>
            ) : filteredConnectors.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <div className="text-gray-500">
                  {connectors.length === 0
                    ? "No MCP connectors found"
                    : "No connectors match your search"}
                </div>
              </div>
            ) : (
              filteredConnectors.map((connector) => {
                const isExpanded = expandedConnectors.has(connector.id)
                const enabledTools = connector.tools.filter((tool) => tool.enabled)
                const isFullySelected = isConnectorSelected(connector)
                const isPartiallySelected = isConnectorPartiallySelected(connector)

                return (
                  <div key={connector.id} className="border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1">
                        <input
                          type="checkbox"
                          checked={isFullySelected}
                          ref={(el) => {
                            if (el) {
                              el.indeterminate = isPartiallySelected && !isFullySelected
                            }
                          }}
                          onChange={(e) =>
                            handleConnectorToggle(connector, e.target.checked)
                          }
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <div className="flex items-center gap-2">
                          <Gavel className="h-4 w-4 text-blue-600" />
                          <span className="font-medium">{connector.name}</span>
                          <Badge variant="outline" className="text-xs">
                            {enabledTools.length} tools
                          </Badge>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleConnectorExpansion(connector.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    
                    {isExpanded && (
                      <div className="mt-3 space-y-2 pl-6">
                        {enabledTools.map((tool) => {
                          const connectorId = connector.id
                          const isSelected = selectedToolsMap
                            .get(connectorId)
                            ?.has(tool.externalId) || false

                          return (
                            <div key={tool.externalId} className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) =>
                                  handleToolSelection(
                                    connector.id,
                                    tool.externalId,
                                    e.target.checked,
                                  )
                                }
                                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mt-0.5"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm">{tool.toolName}</div>
                                {tool.description && (
                                  <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                                    {tool.description}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                        {enabledTools.length === 0 && (
                          <div className="text-sm text-gray-500">
                            No enabled tools available
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="flex justify-between items-center pt-3 border-t">
            <div className="text-sm text-gray-600">
              {getSelectedToolsCount()} tools selected
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setOpen(false)}>
                Save Selection
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
