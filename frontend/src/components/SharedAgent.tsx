import React, { useState, useEffect, useMemo } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import { SelectPublicAgent } from "shared/types"
import { api } from "@/api"
import { Button } from "./ui/button"
import { ArrowLeft } from "lucide-react"
import { availableIntegrationsList } from "@/routes/_authenticated/agent"
interface SharedAgentProps {
  agent: SelectPublicAgent
  onBack: () => void
}
interface CustomBadgeProps {
  text?: string
  icon?: React.ReactNode
}

interface CollectionItem {
  id: string
  name: string
  type: "file" | "folder" | "collection"
  parentId?: string | null
  path?: string
  isCollectionLevel?: boolean
}

const CustomBadge: React.FC<CustomBadgeProps> = ({ text, icon }) => {
  return (
    <div className="flex items-center justify-center bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-slate-200 dark:border-slate-500">
      {icon && <span className="mr-1 flex items-center">{icon}</span>}
      <span>{text}</span>
    </div>
  )
}

const SharedAgent: React.FC<SharedAgentProps> = ({ agent, onBack }) => {
  const [integrationItem, setIntegrationItem] = useState<CollectionItem[]>([])
  const [integrationApps, setIntegrationApps] = useState<string[]>([])

  const currentSelectedIntegrationObjects = useMemo(() => {
    const result: Array<{
      id: string
      name: string
      icon: React.ReactNode
      type?: "file" | "folder" | "integration" | "cl"
      clId?: string
      clName?: string
    }> = []
    for (const integration of availableIntegrationsList) {
      if (integrationApps.includes(integration.id)) {
        result.push({
          id: integration.id,
          name: integration.name,
          icon: integration.icon,
          type: "integration",
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
        const itemIcon =
          itemType === "folder" ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2 text-blue-600"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          ) : itemType === "collection" ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2 text-blue-600"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2 text-blue-600"
            >
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
              <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
          )

        result.push({
          id: integration.id || "",
          name: displayName,
          icon: itemIcon,
          type: itemType as "file" | "folder" | "integration" | "cl",
          clId: clId || "",
          clName: integration.name || "",
        })
      })
    }

    return result
  }, [agent, integrationItem, integrationApps])

  useEffect(() => {
    const fetchAgent = async () => {
      try {
        const response = await api.agent[":agentExternalId"][
          "integration-items"
        ].$get({
          param: { agentExternalId: agent.externalId },
        })

        if (response.ok) {
          const data = await response.json()

          if (data?.integrationItems?.collection?.groups) {
            const groups = data.integrationItems.collection.groups

            const CollectionItems: any[] = Object.values(groups).flat()

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
          }
          if (data.integrationItems) {
            const { collection, ...rest } = data?.integrationItems
            const integrationApps = Object.keys(rest)
            setIntegrationApps(integrationApps)
          }
        }
      } catch (err) {
        console.error("couldn't fetchAgent", err)
      }
    }
    fetchAgent()
  }, [agent])

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

export default SharedAgent
