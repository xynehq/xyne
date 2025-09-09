import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { Sidebar } from "@/components/Sidebar"
import { useRouterState } from "@tanstack/react-router"
import WorkflowBuilder from "@/components/workflow/WorkflowBuilder"
import { WorkflowCard } from "@/components/workflow/WorkflowCard"
import { TemplateSelectionModal } from "@/components/workflow/TemplateSelectionModal"
import { WorkflowExecutionsTable } from "@/components/workflow/WorkflowExecutionsTable"
import { userWorkflowsAPI, templatesAPI, workflowExecutionsAPI } from "@/components/workflow/api/ApiHandlers"
import sitemapIcon from "@/assets/sitemap.svg"
import vectorIcon from "@/assets/vector.svg"
import gridDashboardIcon from "@/assets/grid-dashboard-01.svg"
import playIcon from "@/assets/play.svg"
import importDslIcon from "@/assets/import-dsl.svg"
import plusIcon from "@/assets/plus.svg"

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  status: string;
  config: {
    ai_model?: string;
    max_file_size?: string;
    auto_execution?: boolean;
    schema_version?: string;
    allowed_file_types?: string[];
    supports_file_upload?: boolean;
  };
  createdBy: string;
  rootWorkflowStepTemplateId: string;
  createdAt: string;
  updatedAt: string;
  steps?: Array<{
    id: string;
    workflowTemplateId: string;
    name: string;
    description: string;
    type: string;
    parentStepId: string | null;
    prevStepIds: string[];
    nextStepIds: string[];
    toolIds: string[];
    timeEstimate: number;
    metadata: {
      icon?: string;
      step_order?: number;
      schema_version?: string;
      user_instructions?: string;
      ai_model?: string;
      automated_description?: string;
    };
    createdAt: string;
    updatedAt: string;
  }>;
  workflow_tools?: Array<{
    id: string;
    type: string;
    value: any;
    config: any;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  }>;
  rootStep?: {
    id: string;
    workflowTemplateId: string;
    name: string;
    description: string;
    type: string;
    timeEstimate: number;
    metadata: {
      icon?: string;
      step_order?: number;
      schema_version?: string;
      user_instructions?: string;
    };
    tool?: {
      id: string;
      type: string;
      value: any;
      config: any;
      createdBy: string;
      createdAt: string;
      updatedAt: string;
    };
  };
}

interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconBgColor?: string;
  isPlaceholder?: boolean;
}

interface WorkflowExecution {
  id: string;
  workflowName: string;
  workflowId: string;
  status: 'Success' | 'Running' | 'Failed';
  started: string;
  runTime: string;
}





export const Route = createFileRoute("/_authenticated/workflow")({
  component: WorkflowComponent,
})

function WorkflowComponent() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const [activeTab, setActiveTab] = useState<"workflow" | "templates" | "executions">("workflow")
  const [viewMode, setViewMode] = useState<"list" | "builder">("list")
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [templates, setTemplates] = useState<Template[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(false)
  const [executionsTotal, setExecutionsTotal] = useState(0)
  const [executionsPage, setExecutionsPage] = useState(1)
  const [executionsLimit, setExecutionsLimit] = useState(10)
  const [dateFilter, setDateFilter] = useState("This month")
  const [searchTerm, setSearchTerm] = useState("")
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("")
  const [hasInitiallyLoaded, setHasInitiallyLoaded] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  const [isLoadingTemplate, setIsLoadingTemplate] = useState(false)
  const [isEditableMode, setIsEditableMode] = useState(false)


  const fetchWorkflows = async () => {
    try {
      setLoading(true)
      const workflows = await userWorkflowsAPI.fetchWorkflows()
      
      console.log('Workflows API Response:', workflows)
      if (Array.isArray(workflows.data)) {
        const filteredWorkflows = workflows.data
        setWorkflows(filteredWorkflows)
      } else {
        console.error('Workflows response is not an array')
        setWorkflows([])
      }
    } catch (error) {
      console.error('Failed to fetch workflows:', error)
      setWorkflows([])
    } finally {
      setLoading(false)
    }
  }

  const fetchTemplates = async () => {
    try {
      setTemplatesLoading(true)
      setTemplatesError(null)
      
      const templates = await userWorkflowsAPI.fetchWorkflows()
      
      if (Array.isArray(templates.data)) {
        console.log('Templates API Response:', templates.data)

        
        // Convert WorkflowTemplate to Template interface for modal
        // const convertedTemplates: Template[] = templates.data.map((workflowTemplate) => ({
        //   id: workflowTemplate.id,
        //   name: workflowTemplate.name,
        //   description: workflowTemplate.description,
        //   icon: getTemplateIcon(workflowTemplate),
        //   iconBgColor: getTemplateIconBgColor(workflowTemplate),
        //   isPlaceholder: false
        // }))


        const convertedTemplates: Template[] = templates.data
          .map((workflowTemplate) => ({
            id: workflowTemplate.id,
            name: workflowTemplate.name,
            description: workflowTemplate.description,
            icon: getTemplateIcon(workflowTemplate),
            iconBgColor: getTemplateIconBgColor(workflowTemplate),
            isPlaceholder: false
          }))
        
        // Add placeholder cards to fill the grid
        const placeholderCount = Math.max(0, 3 - convertedTemplates.length)
        const placeholders: Template[] = Array.from({ length: placeholderCount }, (_, index) => ({
          id: `placeholder-${index}`,
          name: 'Placeholder',
          description: '',
          icon: '',
          isPlaceholder: true
        }))
        
        setTemplates([...convertedTemplates, ...placeholders])
      } else {
        console.error('Templates response is not an array')
        setTemplatesError('Failed to fetch templates')
        setTemplates([])
      }
    } catch (error) {
      console.error('Failed to fetch templates:', error)
      setTemplatesError('Failed to fetch templates')
      setTemplates([])
    } finally {
      setTemplatesLoading(false)
    }
  }

  // Helper function to classify search term as UUID or name
  const classifySearchTerm = (term: string) => {
    if (!term.trim()) return null;
    
    // UUID regex pattern (matches various UUID formats)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // Also check for numeric IDs
    const numericIdRegex = /^\d+$/;
    
    if (uuidRegex.test(term.trim()) || numericIdRegex.test(term.trim())) {
      return { id: term.trim() };
    } else {
      return { name: term.trim() };
    }
  };

  // Helper function to get date range based on filter
  const getDateRange = (filter: string) => {
    const now = new Date()
    let fromDate, toDate

    switch (filter) {
      case "Last 7 days":
        fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        toDate = new Date()
        break
      case "Last 15 days":
        fromDate = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)
        toDate = new Date()
        break
      case "This month":
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1)
        toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
        break
      case "Last 3 months":
        fromDate = new Date(now.getFullYear(), now.getMonth() - 3, 1)
        toDate = new Date()
        break
      default:
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1)
        toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    }

    return {
      from_date: fromDate.toISOString(),
      to_date: toDate.toISOString()
    }
  }

  const fetchExecutions = async (page: number = 1, limit: number = 10, filter: string = dateFilter, search: string = searchTerm) => {
    try {
      setExecutionsLoading(true)
      
      const dateRange = getDateRange(filter)
      const searchParams = classifySearchTerm(search)
      
      const payload = {
        limit,
        page,
        ...dateRange,
        ...(searchParams || {})
      }
      
      const response = await workflowExecutionsAPI.fetchAll(payload)
      
      console.log('Executions API Response:', response)
      
      if (response.data && Array.isArray(response.data)) {
        // Convert API executions to UI format
        const convertedExecutions: WorkflowExecution[] = response.data.map((apiExecution) => ({
          id: apiExecution.id,
          workflowName: apiExecution.name,
          workflowId: apiExecution.id,
          status: convertStatus(apiExecution.status),
          started: formatDate(apiExecution.createdAt),
          runTime: calculateRunTime(apiExecution.createdAt, apiExecution.completedAt)
        }))
        
        setExecutions(convertedExecutions)
        setExecutionsTotal(parseInt(response.pagination.totalCount))
        setExecutionsPage(response.pagination.page)
      } else {
        console.error('No data array found in executions response')
        setExecutions([])
      }
    } catch (error) {
      console.error('Failed to fetch executions:', error)
      setExecutions([])
    } finally {
      setExecutionsLoading(false)
    }
  }

  // Helper function to convert API status to UI status
  const convertStatus = (apiStatus: string): 'Success' | 'Running' | 'Failed' => {
    switch (apiStatus) {
      case 'completed':
        return 'Success'
      case 'active':
        return 'Running'
      case 'failed':
        return 'Failed'
      default:
        return 'Failed'
    }
  }

  // Helper function to format date
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', { 
      month: '2-digit', 
      day: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })
  }

  // Helper function to calculate run time
  const calculateRunTime = (createdAt: string, completedAt: string | null): string => {
    const start = new Date(createdAt)
    const end = completedAt ? new Date(completedAt) : new Date()
    const diffMs = end.getTime() - start.getTime()
    const diffSeconds = diffMs / 1000
    
    if (diffSeconds < 60) {
      return `${diffSeconds.toFixed(1)}s`
    } else if (diffSeconds < 3600) {
      const minutes = Math.floor(diffSeconds / 60)
      const seconds = (diffSeconds % 60).toFixed(0)
      return `${minutes}m ${seconds}s`
    } else {
      const hours = Math.floor(diffSeconds / 3600)
      const minutes = Math.floor((diffSeconds % 3600) / 60)
      return `${hours}h ${minutes}m`
    }
  }

  // Helper functions to determine template icon and background color
  const getTemplateIcon = (workflowTemplate: WorkflowTemplate): string => {
    // Use the icon from rootStep metadata if available
    if (workflowTemplate.rootStep?.metadata?.icon) {
      return workflowTemplate.rootStep.metadata.icon
    }
    
    // Fallback to determining icon based on config
    if (workflowTemplate.config.allowed_file_types?.includes('pdf')) {
      return '📄'
    }
    if (workflowTemplate.config.ai_model) {
      return '🤖'
    }
    if (workflowTemplate.config.supports_file_upload) {
      return '📁'
    }
    return '⚡'
  }

  const getTemplateIconBgColor = (workflowTemplate: WorkflowTemplate): string => {
    if (workflowTemplate.config.allowed_file_types?.includes('pdf')) {
      return '#E8F5E8'
    }
    if (workflowTemplate.config.ai_model) {
      return '#EBF4FF'
    }
    if (workflowTemplate.config.supports_file_upload) {
      return '#FEF3C7'
    }
    return '#F3E8FF'
  }

  const handleTemplateModalOpen = () => {
    setShowTemplateModal(true)
    fetchTemplates()
  }

  const handleViewWorkflow = async (templateId: string, editable: boolean = false) => {
    try {
      setIsLoadingTemplate(true)
      console.log('Fetching template by ID:', templateId, 'Editable:', editable)
      
      const response = await userWorkflowsAPI.fetchTemplateById(templateId)
      console.log('🔍 Raw template response:', response)
      
      // Check if response has a data property that needs to be extracted
      const template = (response as any).data || response
      console.log('📋 Template data to use:', template)
      
      setSelectedTemplate(template)
      setIsEditableMode(editable)
      setViewMode("builder")
    } catch (error) {
      console.error('❌ Failed to fetch template:', error)
      console.error('Error details:', error)
    } finally {
      setIsLoadingTemplate(false)
    }
  }

  const handleViewExecution = async (executionId: string) => {
    try {
      setIsLoadingTemplate(true)
      console.log('🔄 Fetching execution by ID:', executionId)
      
      // Hit the specific execution endpoint
      const BACKEND_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
      const token = localStorage.getItem('authToken');
      
      const response = await fetch(`${BACKEND_BASE_URL}/api/v1/workflow/executions/${executionId}`, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'ngrok-skip-browser-warning': 'true',
          'Access-Control-Allow-Origin': '*',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        mode: 'cors',
      })
      
      const executionData = await response.json()
      console.log('🔍 Raw execution response:', executionData)
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      // Extract the execution workflow data for the builder
      // The response should contain the workflow structure
      console.log('📋 Execution data to use:', executionData)
      
      if (executionData) {
        // Extract the workflow structure from the execution response
        let executionTemplate = null
        
        // Try different response structures
        if (executionData.data) {
          executionTemplate = executionData.data
        } else if (executionData.workflow) {
          executionTemplate = executionData.workflow
        } else if (executionData.workflowTemplate) {
          executionTemplate = executionData.workflowTemplate
        } else {
          executionTemplate = executionData
        }
        
        console.log('🏗️ Extracted execution template:', executionTemplate)
        console.log('🔍 Template structure check:', {
          hasSteps: !!executionTemplate?.steps,
          hasStepExecutions: !!executionTemplate?.stepExecutions,
          stepsCount: executionTemplate?.steps?.length || 0,
          stepExecutionsCount: executionTemplate?.stepExecutions?.length || 0,
          hasId: !!executionTemplate?.id,
          hasName: !!executionTemplate?.name,
          keys: Object.keys(executionTemplate || {})
        })
        
        // Check if it has stepExecutions structure (for executions) or steps structure (for templates)
        if (executionTemplate && (
          (executionTemplate.stepExecutions && executionTemplate.stepExecutions.length > 0) ||
          (executionTemplate.steps && executionTemplate.steps.length > 0)
        )) {
          setSelectedTemplate(executionTemplate)
          setIsEditableMode(false) // Always read-only for executions
          setViewMode("builder")
          console.log('✅ Successfully set execution template for builder')
        } else {
          console.log('❌ Execution data does not have valid stepExecutions or steps structure, trying to create workflow from execution data')
          console.log('Available execution data:', executionTemplate)
          
          // Try to create a workflow structure from execution data
          // Check if execution has step_executions or similar
          let steps = []
          
          if (executionTemplate?.step_executions) {
            steps = executionTemplate.step_executions.map((stepExec: any, index: number) => ({
              id: stepExec.id || `step-${index}`,
              workflowTemplateId: executionTemplate.id,
              name: stepExec.name || `Step ${index + 1}`,
              description: stepExec.description || '',
              type: stepExec.type || 'unknown',
              parentStepId: null,
              prevStepIds: [],
              nextStepIds: [],
              toolIds: [],
              timeEstimate: 0,
              metadata: stepExec.metadata || {},
              createdAt: stepExec.createdAt || new Date().toISOString(),
              updatedAt: stepExec.updatedAt || new Date().toISOString()
            }))
          } else if (executionTemplate?.workflow_steps) {
            steps = executionTemplate.workflow_steps.map((step: any, index: number) => ({
              id: step.id || `step-${index}`,
              workflowTemplateId: executionTemplate.id,
              name: step.name || `Step ${index + 1}`,
              description: step.description || '',
              type: step.type || 'unknown',
              parentStepId: null,
              prevStepIds: [],
              nextStepIds: [],
              toolIds: [],
              timeEstimate: 0,
              metadata: step.metadata || {},
              createdAt: step.createdAt || new Date().toISOString(),
              updatedAt: step.updatedAt || new Date().toISOString()
            }))
          } else {
            // Create a single step from the execution itself
            steps = [{
              id: executionTemplate?.id || 'execution-step',
              workflowTemplateId: executionTemplate?.id || 'unknown',
              name: executionTemplate?.name || 'Workflow Execution',
              description: executionTemplate?.description || 'Viewing workflow execution',
              type: 'execution',
              parentStepId: null,
              prevStepIds: [],
              nextStepIds: [],
              toolIds: [],
              timeEstimate: 0,
              metadata: {
                status: executionTemplate?.status
              },
              createdAt: executionTemplate?.createdAt || new Date().toISOString(),
              updatedAt: executionTemplate?.updatedAt || new Date().toISOString()
            }]
          }
          
          console.log('🔧 Created steps from execution:', steps)
          
          if (steps.length > 0) {
            const workflowFromExecution = {
              id: executionTemplate?.id || 'execution-workflow',
              name: executionTemplate?.name || 'Workflow Execution',
              description: executionTemplate?.description || 'Viewing workflow execution',
              version: '1.0',
              status: executionTemplate?.status || 'unknown',
              config: executionTemplate?.config || {},
              createdBy: executionTemplate?.createdBy || '',
              rootWorkflowStepTemplateId: steps[0]?.id || '',
              createdAt: executionTemplate?.createdAt || new Date().toISOString(),
              updatedAt: executionTemplate?.updatedAt || new Date().toISOString(),
              steps: steps,
              workflow_tools: executionTemplate?.workflow_tools || []
            }
            
            console.log('🏗️ Final workflow structure:', workflowFromExecution)
            setSelectedTemplate(workflowFromExecution)
            setIsEditableMode(false)
            setViewMode("builder")
            console.log('✅ Successfully created and set workflow from execution data')
          } else {
            console.error('❌ Could not create workflow structure from execution data')
          }
        }
      } else {
        console.error('❌ No execution data found')
      }
    } catch (error) {
      console.error('❌ Failed to fetch execution:', error)
      console.error('Error details:', error)
    } finally {
      setIsLoadingTemplate(false)
    }
  }


  // Debounce search term
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm)
    }, 500) // 500ms debounce delay

    return () => clearTimeout(timer)
  }, [searchTerm])

  // Initial load on component mount
  useEffect(() => {
    if (!hasInitiallyLoaded) {
      if (activeTab === 'workflow') {
        fetchWorkflows()
      } else if (activeTab === 'executions') {
        fetchExecutions(executionsPage, executionsLimit, dateFilter, debouncedSearchTerm)
      }
      setHasInitiallyLoaded(true)
    }
  }, [])

  // Fetch data when tabs change (after initial load)
  useEffect(() => {
    if (hasInitiallyLoaded) {
      if (activeTab === 'executions') {
        fetchExecutions(executionsPage, executionsLimit, dateFilter, debouncedSearchTerm)
      } else if (activeTab === 'workflow') {
        fetchWorkflows()
      }
    }
  }, [activeTab])

  // Fetch executions when filters change (only for executions tab)
  useEffect(() => {
    if (hasInitiallyLoaded && activeTab === 'executions') {
      fetchExecutions(executionsPage, executionsLimit, dateFilter, debouncedSearchTerm)
    }
  }, [executionsPage, executionsLimit, dateFilter, debouncedSearchTerm])


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
                    onClick={handleTemplateModalOpen}
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
                        <WorkflowCard 
                          key={workflow.id} 
                          workflow={workflow} 
                          onViewClick={(templateId) => handleViewWorkflow(templateId, false)} // false = view-only mode
                        />
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
              <div className="space-y-6">
                {/* Header with Search and Filters */}
                <div className="flex items-center justify-between">
                  <div className="w-80 h-10 bg-gray-100 rounded-lg p-1 flex items-center">
                    <div className="flex-1 bg-white border border-gray-200 rounded-md px-3 py-1.5 flex items-center justify-between shadow-sm">
                      <span className="text-gray-900 font-medium text-sm">All Executions</span>
                      <div className="bg-gray-800 text-white rounded px-1.5 py-0.5 text-xs font-medium">
                        {executionsTotal}
                      </div>
                    </div>
                    
                    <div className="flex-1 px-3 py-1.5 flex items-center justify-between opacity-50 cursor-not-allowed">
                      <span className="text-gray-500 font-medium text-sm">My Executions</span>
                      <div className="bg-gray-400 text-white rounded px-1.5 py-0.5 text-xs font-medium">
                        0
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Search by name or ID"
                        value={searchTerm}
                        onChange={(e) => {
                          setSearchTerm(e.target.value);
                          setExecutionsPage(1);
                        }}
                        className="pl-10 pr-4 h-10 bg-white border border-gray-300 rounded-[10px] focus:outline-none focus:ring-1 focus:ring-gray-600 focus:border-gray-600 w-64"
                      />
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <svg className="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                        </svg>
                      </div>
                    </div>
                    
                    <select className="px-3 h-10 bg-white border border-gray-300 rounded-[10px] focus:outline-none font-medium text-sm leading-5 tracking-normal align-middle">
                      <option>All Workflows</option>
                    </select>
                    <select 
                      value={dateFilter}
                      onChange={(e) => {
                        setDateFilter(e.target.value);
                        setExecutionsPage(1);
                      }}
                      className="px-3 h-10 bg-white border border-gray-300 rounded-[10px] focus:outline-none font-medium text-sm leading-5 tracking-normal align-middle"
                    >
                      <option>This month</option>
                      <option>Last 7 days</option>
                      <option>Last 15 days</option>
                      <option>Last 3 months</option>
                    </select>
                  </div>
                </div>

                {/* Executions Table */}
                <WorkflowExecutionsTable 
                  executions={executions}
                  loading={executionsLoading}
                  currentPage={executionsPage}
                  totalCount={executionsTotal}
                  pageSize={executionsLimit}
                  onPageChange={(page) => {
                    setExecutionsPage(page);
                    fetchExecutions(page, executionsLimit, dateFilter, debouncedSearchTerm);
                  }}
                  onPageSizeChange={(size) => {
                    setExecutionsLimit(size);
                    setExecutionsPage(1);
                    fetchExecutions(1, size, dateFilter, debouncedSearchTerm);
                  }}
                  onRowClick={(execution) => {
                    console.log('Clicked execution:', execution);
                    handleViewExecution(execution.id);
                  }}
                />
              </div>
            )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-hidden">
              <WorkflowBuilder 
                user={user} 
                onBackToWorkflows={() => {
                  setViewMode("list")
                  setSelectedTemplate(null)
                  setIsEditableMode(false)
                }}
                selectedTemplate={selectedTemplate}
                isLoadingTemplate={isLoadingTemplate}
                isEditableMode={isEditableMode}
              />
            </div>
          </div>
        )}
      </div>
      
      {/* Template Selection Modal */}
      <TemplateSelectionModal
        isOpen={showTemplateModal}
        onClose={() => setShowTemplateModal(false)}
        templates={templates}
        loading={templatesLoading}
        error={templatesError}
        onSelectTemplate={(template) => {
          console.log('Selected template:', template);
          handleViewWorkflow(template.id, true); // true = editable mode
        }}
      />
    </div>
  )
}

