import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import { TemplateCard } from "./TemplateCard"

interface Template {
  id: string
  name: string
  description: string
  icon: string
  iconBgColor?: string
  isPlaceholder?: boolean
}

interface TemplateSelectionModalProps {
  isOpen: boolean
  onClose: () => void
  templates: Template[]
  loading?: boolean
  error?: string | null
  onSelectTemplate: (template: Template) => void
}

export function TemplateSelectionModal({
  isOpen,
  onClose,
  templates,
  loading = false,
  error,
  onSelectTemplate,
}: TemplateSelectionModalProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(
    null,
  )

  if (!isOpen) return null

  const handleTemplateSelect = (template: Template) => {
    if (!template.isPlaceholder) {
      setSelectedTemplate(template)
    }
  }

  const handleSelectTemplateClick = () => {
    if (selectedTemplate) {
      onSelectTemplate(selectedTemplate)
      onClose()
      setSelectedTemplate(null)
    }
  }

  const handleClose = () => {
    setSelectedTemplate(null)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-[964px] mx-4 relative max-h-[80vh] overflow-hidden flex flex-col"
        style={{ width: "min(964px, calc(100vw - 2rem))" }}
      >
        {/* Header */}
        <div className="p-8 pb-6 border-b border-gray-100 dark:border-gray-700">
          <button
            onClick={handleClose}
            className="absolute top-6 right-6 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>

          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Select Templates
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            Start with a template to get up and running quickly
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-gray-300 dark:border-gray-600 border-t-gray-600 dark:border-t-gray-400 rounded-full animate-spin mb-4"></div>
              <p className="text-gray-600 dark:text-gray-400">Loading templates...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
                <svg
                  className="w-6 h-6 text-red-600 dark:text-red-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <p className="text-gray-900 dark:text-gray-100 font-medium mb-2">
                Failed to fetch templates
              </p>
              <p className="text-gray-600 dark:text-gray-400">Please refresh and try again</p>
            </div>
          ) : templates.length === 0 ||
            templates.every((t) => t.isPlaceholder) ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
                <svg
                  className="w-6 h-6 text-gray-400 dark:text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
              <p className="text-gray-900 dark:text-gray-100 font-medium mb-2">
                No default templates
              </p>
              <p className="text-gray-600 dark:text-gray-400">
                Templates will appear here when available
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onSelect={handleTemplateSelect}
                  isSelected={selectedTemplate?.id === template.id}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-8 pt-6 border-t border-gray-100 dark:border-gray-700 flex justify-end">
          <Button
            className={`px-8 py-3 rounded-full ${
              selectedTemplate
                ? "bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white"
                : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
            }`}
            onClick={handleSelectTemplateClick}
            disabled={!selectedTemplate}
          >
            Select Template
          </Button>
        </div>
      </div>
    </div>
  )
}
