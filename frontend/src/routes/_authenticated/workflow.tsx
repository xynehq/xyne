import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Sidebar } from "@/components/Sidebar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import WorkflowBuilder from "@/components/workflow/WorkflowBuilder"
import { useRouterState } from "@tanstack/react-router"
import { Workflow, Play, Settings, Users, Clock } from "lucide-react"

export const Route = createFileRoute("/_authenticated/workflow")({
  component: WorkflowComponent,
})

function WorkflowComponent() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user } = matches[matches.length - 1].context
  const [viewMode, setViewMode] = useState<"list" | "builder">("list")

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={false}
      />
      
      <div className="flex flex-col flex-1 h-full md:ml-[60px]">
        {viewMode === "list" ? (
          <div className="p-4 md:py-4 md:px-8 bg-white dark:bg-[#1E1E1E] overflow-y-auto h-full">
            <div className="mt-6">
              <div className="w-full max-w-6xl mx-auto px-4 pt-0 pb-6">
                <div className="flex flex-col space-y-6">
                  {/* Header */}
                  <div className="flex justify-between items-center">
                    <h1 className="text-4xl tracking-wider font-display text-gray-700 dark:text-gray-100">
                      WORKFLOWS
                    </h1>
                    <Button 
                      onClick={() => setViewMode("builder")} 
                      className="bg-slate-800 hover:bg-slate-700 text-white font-mono font-medium rounded-full px-6 py-2 flex items-center gap-2"
                    >
                      <Workflow size={18} /> CREATE WORKFLOW
                    </Button>
                  </div>

                  {/* Workflow Stats */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <Card className="dark:bg-slate-800">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">Total Workflows</p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">12</p>
                          </div>
                          <Workflow className="h-8 w-8 text-blue-600" />
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="dark:bg-slate-800">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">Active</p>
                            <p className="text-2xl font-bold text-green-600">8</p>
                          </div>
                          <Play className="h-8 w-8 text-green-600" />
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="dark:bg-slate-800">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">Shared</p>
                            <p className="text-2xl font-bold text-purple-600">5</p>
                          </div>
                          <Users className="h-8 w-8 text-purple-600" />
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="dark:bg-slate-800">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">Scheduled</p>
                            <p className="text-2xl font-bold text-orange-600">3</p>
                          </div>
                          <Clock className="h-8 w-8 text-orange-600" />
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Workflow List */}
                  <div className="space-y-4">
                    <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-100">
                      Your Workflows
                    </h2>
                    
                    {/* Sample Workflow Cards */}
                    {[
                      {
                        name: "Data Processing Pipeline",
                        description: "Automated data extraction and processing from multiple sources",
                        status: "active",
                        lastRun: "2 hours ago",
                      },
                      {
                        name: "Report Generation",
                        description: "Weekly analytics report generation and distribution",
                        status: "scheduled",
                        lastRun: "1 day ago",
                      },
                      {
                        name: "Customer Onboarding",
                        description: "Automated workflow for new customer setup and welcome sequence",
                        status: "active",
                        lastRun: "30 minutes ago",
                      },
                    ].map((workflow, index) => (
                      <Card key={index} className="dark:bg-slate-800 hover:shadow-md transition-shadow cursor-pointer">
                        <CardHeader className="pb-3">
                          <div className="flex items-center justify-between">
                            <CardTitle className="text-lg font-medium text-gray-900 dark:text-gray-100">
                              {workflow.name}
                            </CardTitle>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                                workflow.status === 'active' 
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                  : 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
                              }`}>
                                {workflow.status}
                              </span>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <Settings size={16} />
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <p className="text-gray-600 dark:text-gray-400 text-sm mb-2">
                            {workflow.description}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-500">
                            Last run: {workflow.lastRun}
                          </p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {/* Empty State (if no workflows) */}
                  <div className="text-center py-12 hidden">
                    <Workflow className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-600 mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                      No workflows yet
                    </h3>
                    <p className="text-gray-600 dark:text-gray-400 mb-6">
                      Create your first workflow to automate tasks and processes.
                    </p>
                    <Button className="bg-slate-800 hover:bg-slate-700 text-white">
                      <Workflow size={16} className="mr-2" />
                      Create Your First Workflow
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <WorkflowBuilder user={user} />
        )}
      </div>
    </div>
  )
}