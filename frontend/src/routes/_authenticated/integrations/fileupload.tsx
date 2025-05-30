import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { Sidebar } from '@/components/Sidebar'
import { IntegrationsSidebar } from '@/components/IntegrationsSidebar'
import FileUpload from '@/components/FileUpload'
import FileAccordion from '@/components/FileAccordion'

export const Route = createFileRoute('/_authenticated/integrations/fileupload')(
  {
    component: FileUploadIntegration,
  },
)

function FileUploadIntegration() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user } = matches[matches.length - 1].context

  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ''} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full overflow-y-auto"> 
        <div className="flex flex-col w-full"> 
          <div className="w-full max-w-4xl mx-auto p-6 pt-8"> 
            <FileUpload />
            <div className="mt-8">
              <FileAccordion />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
