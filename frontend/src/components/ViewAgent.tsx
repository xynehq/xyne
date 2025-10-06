import React, { useState, useEffect, useMemo } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import { SelectPublicAgent } from "shared/types"
import { api } from "@/api"
import { Button } from "./ui/button"
import { ArrowLeft } from "lucide-react"
import {
  availableIntegrationsList,
  CollectionItem,
  getItemIcon,
} from "@/routes/_authenticated/agent"

interface ViewAgentProps {
  agent: SelectPublicAgent
  onBack: () => void
}
interface CustomBadgeProps {
  text?: string
  icon?: React.ReactNode
}
enum IntegrationObjectType {
  FILE = "file",
  FOLDER = "folder",
  INTEGRATION = "integration",
  COLLECTION = "cl",
}

const CustomBadge: React.FC<CustomBadgeProps> = ({ text, icon }) => {
  return (
    <div className="flex items-center justify-center bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-slate-200 dark:border-slate-500">
      {icon && <span className="mr-1 flex items-center">{icon}</span>}
      <span>{text}</span>
    </div>
  )
}

const ViewAgent: React.FC<ViewAgentProps> = ({ agent, onBack }) => {
  const [integrationItem, setIntegrationItem] = useState<CollectionItem[]>([])
  const [integrationApps, setIntegrationApps] = useState<string[]>([])

  const currentSelectedIntegrationObjects = useMemo(() => {
    const result: Array<{
      id: string
      name: string
      icon: React.ReactNode
      type?: IntegrationObjectType
      clId?: string
      clName?: string
    }> = []
    for (const integration of availableIntegrationsList) {
      if (integrationApps.includes(integration.id)) {
        result.push({
          id: integration.id,
          name: integration.name,
          icon: integration.icon,
          type: IntegrationObjectType.INTEGRATION,
          clId: integration.id,
          clName: integration.name,
        })
      }
    }

    if (Array.isArray(integrationItem)) {
      integrationItem.forEach((integration) => {
        const clId = integration?.id
        let displayName = integration.name || "integration"
        const itemType = integration.type || "integration"
        const itemIcon = getItemIcon(itemType)
         
        result.push({
          id: integration.id || "",
          name: displayName,
          icon: itemIcon,
          type: itemType as IntegrationObjectType,
          clId: clId || "",
          clName: integration.name || "",
        })
      })
    }

    return result
  }, [agent, integrationItem, integrationApps])

  useEffect(() => {
    let isCancelled = false
    setIntegrationItem([])
    setIntegrationApps([])
    const fetchAgent = async () => {
      try {
        const response = await api.agent[":agentExternalId"][
          "integration-items"
        ].$get({
          param: { agentExternalId: agent.externalId },
        })
        if (isCancelled) {
          return
        }
        if (!isCancelled && response.ok) {
          const data = await response.json()

          if (data?.integrationItems?.collection?.groups) {
            const groups = data.integrationItems.collection.groups

            const CollectionItems: CollectionItem[] = Object.values(
              groups,
            ).flat() as CollectionItem[]

            const updatedItems = await Promise.all(
              CollectionItems.map(async (item) => {
                if (item.type === "collection") {
                  try {
                    const res = await api.cl[":clId"]["name"].$get({
                      param: { clId: item.id },
                      query: {
                        agentExternalId: agent.externalId,
                      },
                    })
                    if (res.ok) {
                      const { name } = await res.json()
                      return { ...item, name }
                    }
                  } catch (err) {
                    console.error(
                      "Failed to fetch collection name for:",
                      item.id,
                      err,
                    )
                  }
                }
                return item
              }),
            )

            setIntegrationItem(updatedItems)
          } else {
            setIntegrationItem([])
          }
          if (data.integrationItems) {
            const { collection, ...rest } = data?.integrationItems
            const integrationApps = Object.keys(rest)
            setIntegrationApps(integrationApps)
          } else {
            setIntegrationApps([])
          }
        }
      } catch (err) {
        if (!isCancelled) {
          console.error("couldn't fetchAgent", err)
        }
      }
    }
    fetchAgent()
    return () => {
      isCancelled = true
    }
  }, [agent.externalId])

  return (
    <div className="w-full flex flex-col items-center">
      <div className="flex items-center mb-4 w-full max-w-xl">
        <Button
          variant="ghost"
          size="icon"
          className="mr-2 text-gray-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-slate-700"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </Button>
        <h1 className="text-2xl font-semibold text-gray-700 dark:text-gray-100">
          {"VIEW AGENT"}
        </h1>
      </div>

      <div className="w-full max-w-2xl space-y-6">
        <div className="w-full">
          <Label
            htmlFor="agentName"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Name
          </Label>
          <Input
            id="agentName"
            placeholder="e.g., Report Generator"
            value={agent.name}
            readOnly
            className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full text-base h-11 px-3 dark:text-gray-100"
          />
        </div>

        <div className="w-full">
          <Label
            htmlFor="agentDescription"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Description
          </Label>
          <Textarea
            id="agentDescription"
            placeholder="e.g., Helps with generating quarterly financial reports..."
            value={agent.description}
            readOnly
            className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full h-24 p-3 text-base dark:text-gray-100"
          />
        </div>
        <div className="w-full">
          <div className="flex items-center justify-between mb-2">
            <Label
              htmlFor="agentPrompt"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Prompt
            </Label>
          </div>
          <Textarea
            id="agentPrompt"
            placeholder="e.g., You are a helpful assistant..."
            value={agent.prompt}
            readOnly
            className={`mt-1 bg-white dark:bg-slate-700 border rounded-lg w-full h-36 p-3 text-base dark:text-gray-100 transition-all duration-300 ${"border-blue-400 ring-2 ring-blue-200 dark:border-blue-500 dark:ring-blue-900/50 shadow-lg"}`}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-3">
            <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
              App Integrations
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-300 dark:border-gray-600 rounded-lg min-h-[48px] bg-white dark:bg-slate-700">
            {currentSelectedIntegrationObjects.length === 0 && (
              <span className="text-gray-400 dark:text-gray-400 text-sm">
                Add integrations..
              </span>
            )}
            {currentSelectedIntegrationObjects.map((integration) => (
              <CustomBadge
                key={integration.id}
                text={integration.name}
                icon={integration.icon}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ViewAgent
