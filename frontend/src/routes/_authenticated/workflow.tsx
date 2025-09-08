import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect, useRef } from "react"
import { Sidebar } from "@/components/Sidebar"
import { useRouterState } from "@tanstack/react-router"
import WorkflowBuilder from "@/components/workflow/WorkflowBuilder"
import { WorkflowCard } from "@/components/workflow/WorkflowCard"
import sitemapIcon from "@/assets/sitemap.svg"
import vectorIcon from "@/assets/vector.svg"
import gridDashboardIcon from "@/assets/grid-dashboard-01.svg"
import playIcon from "@/assets/play.svg"
import importDslIcon from "@/assets/import-dsl.svg"
import plusIcon from "@/assets/plus.svg"

interface WorkflowData {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'scheduled' | 'draft';
  lastRun?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  icon?: string;
  color?: string;
}


export const Route = createFileRoute("/_authenticated/workflow")({
  component: WorkflowComponent,
})

function WorkflowComponent() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const [activeTab, setActiveTab] = useState<"workflow" | "templates" | "executions">("workflow")
  const [viewMode, setViewMode] = useState<"list" | "builder">("list")
  const [workflows, setWorkflows] = useState<WorkflowData[]>([])
  const [loading, setLoading] = useState(true)
  const hasFetched = useRef(false)

  const fetchWorkflows = async () => {
    if (hasFetched.current) return
    hasFetched.current = true
    try {
      setLoading(true)
      const response = await fetch('/user/fetch/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: user?.id, // or omit and rely on session on the server
        })
      })
      if (response.ok) {
        const data = await response.json()
        console.log('API Response:', data)
        
        // Handle different possible response structures
        if (data.workflows && Array.isArray(data.workflows)) {
          setWorkflows(data.workflows)
        } else if (Array.isArray(data)) {
          setWorkflows(data)
        } else {
          console.error('Unexpected response structure:', data)
          setWorkflows([])
        }
      } else {
        console.error('API response not ok:', response.status, response.statusText)
        setWorkflows([])
      }
    } catch (error) {
      console.error('Failed to fetch workflows:', error)
      setWorkflows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWorkflows()
  }, [])


  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-gray-50 dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      
      <div className="flex flex-col flex-1 h-full md:ml-[60px]">
        {viewMode === "list" ? (
          <div className="p-8 bg-gray-50 dark:bg-[#1E1E1E] overflow-y-auto h-full">
            <div className="w-full">
              {/* Header */}
              <div className="mb-8">
                <h1 className="text-3xl font-semibold text-gray-900 dark:text-gray-100 mb-8">
                  Workflow Builder
                </h1>
              
              {/* Tabs */}
              <div className="flex gap-8 border-b border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setActiveTab("workflow")}
                  className={`pb-3 px-1 border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === "workflow"
                      ? "border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100"
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                  style={{
                    fontFamily: 'var(--font-family-body)',
                    fontWeight: 500,
                    fontSize: 'var(--font-size-body-md)',
                    lineHeight: 'var(--font-line-height-20)',
                    letterSpacing: 'var(--font-letter-spacing-normal)'
                  }}
                >
                  <img src={vectorIcon} alt="Workflow" className="w-4 h-4" />
                  Workflow
                </button>
                <button
                  onClick={() => setActiveTab("templates")}
                  className={`pb-3 px-1 border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === "templates"
                      ? "border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100"
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                  style={{
                    fontFamily: 'var(--font-family-body)',
                    fontWeight: 500,
                    fontSize: 'var(--font-size-body-md)',
                    lineHeight: 'var(--font-line-height-20)',
                    letterSpacing: 'var(--font-letter-spacing-normal)'
                  }}
                >
                  <img src={gridDashboardIcon} alt="Templates" className="w-4 h-4" />
                  Templates
                </button>
                <button
                  onClick={() => setActiveTab("executions")}
                  className={`pb-3 px-1 border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === "executions"
                      ? "border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100"
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                  style={{
                    fontFamily: 'var(--font-family-body)',
                    fontWeight: 500,
                    fontSize: 'var(--font-size-body-md)',
                    lineHeight: 'var(--font-line-height-20)',
                    letterSpacing: 'var(--font-letter-spacing-normal)'
                  }}
                >
                  <img src={playIcon} alt="Executions" className="w-4 h-4" />
                  Executions
                </button>
              </div>
            </div>

            {/* Tab Content */}
            {activeTab === "workflow" && (
              <div className="space-y-8">
                {/* Creation Options */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div 
                    className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow cursor-pointer group w-full"
                    style={{
                      height: '64px',
                      borderRadius: '16px',
                      padding: '12px',
                      opacity: 1
                    }}
                    onClick={() => setViewMode("builder")}
                  >
                    <div className="flex items-center justify-between h-full">
                      <div className="flex items-center" style={{ gap: '12px' }}>
                        <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-gray-700 rounded-lg flex items-center justify-center">
                          <img src={plusIcon} alt="Plus" className="w-5 h-5" />
                        </div>
                        <span 
                          className="text-gray-900 dark:text-gray-100"
                          style={{
                            fontFamily: 'Inter',
                            fontWeight: 600,
                            fontSize: '14px',
                            lineHeight: '100%',
                            letterSpacing: '-1%',
                            verticalAlign: 'middle'
                          }}
                        >
                          Create from Blank
                        </span>
                      </div>
                      <div className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">
                        ›
                      </div>
                    </div>
                  </div>

                  <div 
                    className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow cursor-pointer group w-full"
                    style={{
                      height: '64px',
                      borderRadius: '16px',
                      padding: '12px',
                      opacity: 1
                    }}
                  >
                    <div className="flex items-center justify-between h-full">
                      <div className="flex items-center" style={{ gap: '12px' }}>
                        <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-gray-700 rounded-lg flex items-center justify-center">
                          <img src={sitemapIcon} alt="Templates" className="w-5 h-5" />
                        </div>
                        <span 
                          className="text-gray-900 dark:text-gray-100"
                          style={{
                            fontFamily: 'Inter',
                            fontWeight: 600,
                            fontSize: '14px',
                            lineHeight: '100%',
                            letterSpacing: '-1%',
                            verticalAlign: 'middle'
                          }}
                        >
                          Create from Templates
                        </span>
                      </div>
                      <div className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">
                        ›
                      </div>
                    </div>
                  </div>

                  <div 
                    className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow cursor-pointer group w-full"
                    style={{
                      height: '64px',
                      borderRadius: '16px',
                      padding: '12px',
                      opacity: 1
                    }}
                  >
                    <div className="flex items-center justify-between h-full">
                      <div className="flex items-center" style={{ gap: '12px' }}>
                        <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-gray-700 rounded-lg flex items-center justify-center">
                          <img src={importDslIcon} alt="Import DSL" className="w-5 h-5" />
                        </div>
                        <span 
                          className="text-gray-900 dark:text-gray-100"
                          style={{
                            fontFamily: 'Inter',
                            fontWeight: 600,
                            fontSize: '14px',
                            lineHeight: '100%',
                            letterSpacing: '-1%',
                            verticalAlign: 'middle'
                          }}
                        >
                          Import DSL file
                        </span>
                      </div>
                      <div className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">
                        ›
                      </div>
                    </div>
                  </div>
                </div>

                {/* Your Workflows Section */}
                <div>
                  <h2 className="text-gray-900 dark:text-gray-400 uppercase mb-6" style={{
                    fontFamily: 'JetBrains Mono',
                    fontWeight: 500,
                    fontSize: '16px',
                    lineHeight: '14px',
                    letterSpacing: '6%'
                  }}>
                    YOUR WORKFLOWS
                  </h2>
                  
                  {loading ? (
                    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, 327px)' }}>
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="animate-pulse">
                          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
                            <div className="w-12 h-12 bg-gray-200 dark:bg-gray-700 rounded-lg mb-4"></div>
                            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded mb-2"></div>
                            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-2/3 mb-4"></div>
                            <div className="flex gap-2">
                              <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
                              <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : workflows.length > 0 ? (
                    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, 327px)' }}>
                      {workflows.map((workflow) => (
                        <WorkflowCard key={workflow.id} workflow={workflow} />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-gray-600 dark:text-gray-400">No workflows found.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "templates" && (
              <div className="text-center py-12">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Templates</h3>
                <p className="text-gray-600 dark:text-gray-400">Browse and use workflow templates.</p>
              </div>
            )}

            {activeTab === "executions" && (
              <div className="text-center py-12">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Executions</h3>
                <p className="text-gray-600 dark:text-gray-400">View workflow execution history.</p>
              </div>
            )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-hidden">
              <WorkflowBuilder 
                user={user} 
                onBackToWorkflows={() => setViewMode("list")}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

