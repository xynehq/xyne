import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { api } from "@/api"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import FileUpload from "@/components/FileUpload"
import FileAccordion from "@/components/FileAccordion"
import { DataSourceSidebar } from "@/components/DataSourceSidebar"
import { ChevronDown, ChevronUp, UploadCloud } from "lucide-react"

export const Route = createFileRoute("/_authenticated/integrations/fileupload")(
  {
    component: FileUploadIntegration,
  },
)

interface ApiDataSource {
  name: string
  docId: string
  createdBy: string
}

function FileUploadIntegration() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context

  const [dataSources, setDataSources] = useState<ApiDataSource[]>([])
  const [activeDataSource, setActiveDataSource] =
    useState<ApiDataSource | null>(null)
  const [showNewDataSource, setShowNewDataSource] = useState(true)
  const [isUploadMoreOpen, setIsUploadMoreOpen] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  const refreshFilesForActiveDataSource = () => {
    setRefreshKey((prevKey) => prevKey + 1)
  }

  const fetchApiDataSources = async () => {
    try {
      const response = await api.datasources.$get()
      if (response.ok) {
        const apiData = (await response.json()) as ApiDataSource[]
        setDataSources(apiData)
        if (apiData.length === 0) {
          setShowNewDataSource(true)
        }
      } else {
        const errorText = await response.text()
        console.error("Failed to fetch data sources from API:", errorText)
      }
    } catch (error) {
      console.error("Error fetching data sources:", error)
    }
  }

  useEffect(() => {
    fetchApiDataSources()
  }, [])

  const handleDatasourceCreated = async (name: string) => {
    await fetchApiDataSources()
    const newDataSource = dataSources.find((ds) => ds.name === name)
    if (newDataSource) {
      setActiveDataSource(newDataSource)
    }
    setShowNewDataSource(false)
  }

  const handleDataSourceDeleted = () => {
    fetchApiDataSources()
    setActiveDataSource(null)
    setShowNewDataSource(true)
  }

  const handleSelectDataSource = (name: string) => {
    const selected = dataSources.find((ds) => ds.name === name)
    if (selected) {
      setActiveDataSource(selected)
      setShowNewDataSource(false)
    }
  }

  const handleAddNewDataSource = () => {
    setShowNewDataSource(true)
    setActiveDataSource(null)
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="flex w-full h-full overflow-hidden">
        <DataSourceSidebar
          dataSources={dataSources.map((ds) => ({
            name: ds.name,
            docId: ds.docId,
          }))}
          activeDataSource={activeDataSource?.name || null}
          onSelectDataSource={handleSelectDataSource}
          onAddNewDataSource={handleAddNewDataSource}
          onDataSourceDeleted={handleDataSourceDeleted}
        />
        <div className="flex-1 overflow-y-auto">
          <div className="w-full max-w-4xl mx-auto p-6 pt-8">
            {showNewDataSource ? (
              <FileUpload
                onDatasourceCreated={handleDatasourceCreated}
                existingDataSourceNames={dataSources.map((ds) => ds.name)}
              />
            ) : activeDataSource ? (
              <div>
                <div className="mb-6 text-center">
                  <div className="flex items-center justify-center space-x-2">
                    <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">
                      {activeDataSource.name}
                    </h2>
                  </div>
                  <p className="text-gray-600 dark:text-gray-300 mt-1">
                    Upload more files to this data source.
                  </p>
                </div>

                <div className="mb-8">
                  <div
                    className="flex items-center justify-between p-4 border dark:border-gray-700 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800"
                    onClick={() => setIsUploadMoreOpen(!isUploadMoreOpen)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setIsUploadMoreOpen(!isUploadMoreOpen)
                    }}
                    aria-expanded={isUploadMoreOpen}
                    aria-controls="upload-more-content"
                  >
                    <div className="flex items-center gap-3">
                      <UploadCloud className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                      <span className="text-lg font-medium dark:text-gray-200">
                        Upload more files to this datasource
                      </span>
                    </div>
                    {isUploadMoreOpen ? (
                      <ChevronUp className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                    ) : (
                      <ChevronDown className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                    )}
                  </div>

                  {isUploadMoreOpen && (
                    <div id="upload-more-content">
                      <FileUpload
                        initialDatasourceName={activeDataSource.name}
                        onDatasourceCreated={handleDatasourceCreated}
                        onUploadCompleted={refreshFilesForActiveDataSource}
                      />
                    </div>
                  )}
                </div>

                <div className="mt-8 mb-8">
                  <h3 className="text-lg font-medium mb-4 dark:text-gray-200">
                    Files in {activeDataSource.name}
                  </h3>
                  <FileAccordion
                    activeDataSourceName={activeDataSource.name}
                    refreshKey={refreshKey}
                  />
                </div>
              </div>
            ) : (
              <div className="text-center py-16">
                <h2 className="text-xl font-medium text-gray-700 dark:text-gray-200 mb-2">
                  Select a data source
                </h2>
                <p className="text-gray-500 dark:text-gray-400">
                  Choose a data source from the sidebar or create a new one
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
