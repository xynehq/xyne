import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { IntegrationsSidebar } from '@/components/IntegrationsSidebar'
import FileUpload from '@/components/FileUpload'
import FileAccordion from '@/components/FileAccordion'
import { DataSourceSidebar } from '@/components/DataSourceSidebar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp, UploadCloud } from 'lucide-react'

export const Route = createFileRoute('/_authenticated/integrations/fileupload')(
  {
    component: FileUploadIntegration,
  },
)

function FileUploadIntegration() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user } = matches[matches.length - 1].context
  
  const [dataSources, setDataSources] = useState<string[]>([])
  const [activeDataSource, setActiveDataSource] = useState<string | null>(null)
  const [showNewDataSource, setShowNewDataSource] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const [editedName, setEditedName] = useState("")
  const [isUploadMoreOpen, setIsUploadMoreOpen] = useState(true)

  // Effect to load datasources from API or localStorage
  useEffect(() => {
    const savedDataSources = localStorage.getItem('dataSources')
    if (savedDataSources) {
      try {
        const parsed = JSON.parse(savedDataSources)
        setDataSources(Array.isArray(parsed) ? parsed : [])
      } catch (e) {
        console.error("Failed to parse datasources from localStorage", e)
        setDataSources([])
      }
    }
  }, [])

  // Save datasources to localStorage when they change
  useEffect(() => {
    localStorage.setItem('dataSources', JSON.stringify(dataSources))
  }, [dataSources])

  const handleDatasourceCreated = (name: string) => {
    if (!dataSources.includes(name)) {
      setDataSources(prev => [...prev, name])
    }
    setActiveDataSource(name)
    setShowNewDataSource(false)
  }

  const handleSelectDataSource = (name: string) => {
    setActiveDataSource(name)
    setShowNewDataSource(false)
  }

  const handleAddNewDataSource = () => {
    setShowNewDataSource(true)
    setActiveDataSource(null)
  }

  const handleEditSave = () => {
    if (!editedName.trim() || !activeDataSource) return;
    
    // Update the datasource name in the list
    setDataSources(prev => prev.map(name => 
      name === activeDataSource ? editedName.trim() : name
    ));
    
    // Update active datasource
    setActiveDataSource(editedName.trim());
    
    // Exit edit mode
    setIsEditing(false);
  }

  const handleEditStart = () => {
    if (activeDataSource) {
      setEditedName(activeDataSource);
      setIsEditing(true);
    }
  }

  const handleEditCancel = () => {
    setIsEditing(false);
    setEditedName("");
  }

  const handleDeleteDataSource = () => {
    if (!activeDataSource) return;
    
    // Remove the datasource from the list
    setDataSources(prev => prev.filter(name => name !== activeDataSource));
    
    // Reset active datasource and show new datasource view
    setActiveDataSource(null);
    setShowNewDataSource(true);
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ''} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="flex w-full h-full overflow-hidden"> 
        <DataSourceSidebar
          dataSources={dataSources}
          activeDataSource={activeDataSource}
          onSelectDataSource={handleSelectDataSource}
          onAddNewDataSource={handleAddNewDataSource}
        />
        <div className="flex-1 overflow-y-auto"> 
          <div className="w-full max-w-4xl mx-auto p-6 pt-8"> 
            {showNewDataSource ? (
              <FileUpload 
                onDatasourceCreated={handleDatasourceCreated}
              />
            ) : activeDataSource ? (
              <div>
                <div className="mb-6 text-center">
                  <div className="flex items-center justify-center space-x-2">
                    {isEditing ? (
                      <div className="flex items-center space-x-2">
                        <Input
                          value={editedName}
                          onChange={(e) => setEditedName(e.target.value)}
                          className="w-64 text-xl font-semibold h-9 px-2 py-1"
                          autoFocus
                        />
                        <Button 
                          onClick={handleEditSave}
                          disabled={!editedName.trim() || editedName.trim() === activeDataSource}
                          className="h-9 px-3 bg-gray-800 text-white hover:bg-gray-900 rounded"
                        >
                          Save
                        </Button>
                        <Button 
                          onClick={handleEditCancel}
                          variant="ghost"
                          className="h-9 px-3"
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <h2 className="text-2xl font-semibold text-gray-800">{activeDataSource}</h2>
                        <button 
                          className="p-1 hover:bg-gray-100 rounded-full transition-colors"
                          onClick={handleEditStart}
                        >
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            className="h-5 w-5 text-gray-500"
                            viewBox="0 0 20 20" 
                            fill="currentColor"
                          >
                            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                          </svg>
                        </button>
                        <button 
                          className="p-1 hover:bg-gray-100 rounded-full transition-colors ml-1"
                          onClick={handleDeleteDataSource}
                        >
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            className="h-5 w-5 text-gray-500"
                            viewBox="0 0 20 20" 
                            fill="currentColor"
                          >
                            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                  <p className="text-gray-600 mt-1">Manage your data source or upload more files.</p>
                </div>

                {/* New Collapser for Uploading More Files */}
                <div className="mb-8">
                  <div
                    className="flex items-center justify-between p-4 border rounded-lg cursor-pointer hover:bg-gray-50"
                    onClick={() => setIsUploadMoreOpen(!isUploadMoreOpen)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsUploadMoreOpen(!isUploadMoreOpen); }}
                    aria-expanded={isUploadMoreOpen}
                    aria-controls="upload-more-content"
                  >
                    <div className="flex items-center gap-3">
                      <UploadCloud className="h-5 w-5 text-slate-600" />
                      <span className="text-lg font-medium">Upload more files to this datasource</span>
                    </div>
                    {isUploadMoreOpen ? <ChevronUp className="h-5 w-5 text-slate-600" /> : <ChevronDown className="h-5 w-5 text-slate-600" />}
                  </div>

                  {isUploadMoreOpen && (
                    <div id="upload-more-content"> {/* Removed padding, border, and background classes */}
                      <FileUpload 
                        initialDatasourceName={activeDataSource}
                        onDatasourceCreated={() => {
                          // Potentially refresh file list in FileAccordion or show a toast
                        }}
                      />
                    </div>
                  )}
                </div>
                
                {/* Existing Files Accordion */}
                <div className="mt-8 mb-8">
                  <h3 className="text-lg font-medium mb-4">Uploaded Files</h3>
                  <FileAccordion />
                </div>
              </div>
            ) : (
              <div className="text-center py-16">
                <h2 className="text-xl font-medium text-gray-700 mb-2">Select a data source</h2>
                <p className="text-gray-500">Choose a data source from the sidebar or create a new one</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
