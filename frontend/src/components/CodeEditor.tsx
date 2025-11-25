import React, { useRef, useEffect } from "react"
import { Editor } from "@monaco-editor/react"
import { X, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { editor } from "monaco-editor"

interface CodeEditorProps {
  isOpen: boolean
  onClose: () => void
  language: string
  initialValue: string
  onChange: (value: string) => void
  onSave: (value: string) => void
  theme?: 'light' | 'dark' // Add optional theme prop
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  isOpen,
  onClose,
  language,
  initialValue,
  onChange,
  onSave,
  theme,
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [currentValue, setCurrentValue] = React.useState(initialValue)
  const [isMonacoLoading, setIsMonacoLoading] = React.useState(true)
  const [monacoError, setMonacoError] = React.useState<string | null>(null)
  
  // Simple initialization without custom loader configuration
  useEffect(() => {
    if (isOpen) {
      // Set loading to false immediately - let Monaco handle its own loading
      const timer = setTimeout(() => {
        setIsMonacoLoading(false)
      }, 1000)
      
      return () => clearTimeout(timer)
    }
  }, [isOpen])
  
  // Use parent theme if provided, otherwise fall back to auto-detection
  const monacoTheme = theme === 'dark' ? 'vs-dark' : theme === 'light' ? 'vs' : 'vs'

  // Update current value when initialValue changes
  useEffect(() => {
    setCurrentValue(initialValue)
  }, [initialValue])

  // Handle editor mount
  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
    editorRef.current = editor
    setIsMonacoLoading(false) // Editor successfully mounted
    setMonacoError(null)
    
    // Fix for Chrome single space issue
    editor.addCommand(monaco.KeyCode.Space, () => {
      const position = editor.getPosition()
      if (position) {
        editor.trigger('keyboard', 'type', { text: ' ' })
      }
      return true // Prevent default space handling
    })
    
    // Focus the editor after a brief delay to ensure proper initialization
    setTimeout(() => {
      editor.focus()
      // Set cursor to end of content if there's initial content
      if (initialValue) {
        const model = editor.getModel()
        if (model) {
          const lineCount = model.getLineCount()
          const lastLineLength = model.getLineLength(lineCount)
          editor.setPosition({ lineNumber: lineCount, column: lastLineLength + 1 })
        }
      }
    }, 100)
  }

  // Handle value change
  const handleEditorChange = (value: string | undefined) => {
    const newValue = value || ""
    setCurrentValue(newValue)
    onChange(newValue)
  }

  // Handle save
  const handleSave = () => {
    onSave(currentValue)
    onClose()
  }


  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center">
      <div 
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[90vw] h-[80vh] flex flex-col overflow-hidden"
        // onKeyDown={handleKeyDown}
        // tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Code Editor
            </h2>
            <span className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded capitalize">
              {language}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          {isMonacoLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-600 rounded-full mx-auto mb-4"></div>
                <p className="text-gray-600 dark:text-gray-400">Loading Monaco Editor...</p>
              </div>
            </div>
          ) : monacoError ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-red-500 mb-4">{monacoError}</p>
                <textarea
                  className="w-full h-64 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 font-mono text-sm resize-none"
                  value={currentValue}
                  onChange={(e) => handleEditorChange(e.target.value)}
                  placeholder={`Enter your ${language} code here...`}
                />
              </div>
            </div>
          ) : (
            <Editor
              height="100%"
              language={language}
              value={currentValue}
              onChange={handleEditorChange}
              onMount={handleEditorDidMount}
              loading={
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-600 rounded-full mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading Monaco Editor...</p>
                  </div>
                </div>
              }
              theme={monacoTheme}
              options={{
                fontSize: 14,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                lineNumbers: "on",
                folding: true,
                cursorSmoothCaretAnimation: "off",
                selectOnLineNumbers: true,
                insertSpaces: true,
                wordWrap: "on",
                contextmenu: true,
                mouseWheelZoom: true,
                smoothScrolling: true,
                cursorBlinking: "blink"
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-end">
          <Button
            onClick={handleSave}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm"
            size="sm"
          >
            <Save className="w-4 h-4 mr-2" />
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}