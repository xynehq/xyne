import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import Dropdown from "@/components/ui/dropdown"
import { FileText, ChevronDown, Upload, File, X } from "lucide-react"
import { BackArrowIcon, CloseIcon } from "./WorkflowIcons"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface OnFormSubmissionUIProps {
  isVisible?: boolean 
  onBack: () => void
  onClose?: () => void 
  onSave?: (formConfig: FormConfig, apiResponse?: any) => void
  initialConfig?: FormConfig
  toolData?: any 
  toolId?: string 
  showBackButton?: boolean 
  builder?: boolean
}

interface FormField {
  id: string
  name: string
  placeholder: string
  type: "text" | "email" | "file" | "number" | "textarea" | "dropdown"
  options?: string[] 
  fileTypes?: string[] 
  required?: boolean
  maxSize?: string
}

export interface FormConfig {
  title: string
  description: string
  fields: FormField[]
}


const VALID_FILE_TYPES = [
  "pdf", "doc", "docx", "txt", "rtf", "odt",
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg",
  "mp4", "avi", "mov", "wmv", "flv", "webm",
  "mp3", "wav", "flac", "aac", "ogg",
  "zip", "rar", "7z", "tar", "gz",
  "xls", "xlsx", "csv", "ppt", "pptx",
  "json", "xml", "html", "css", "js", "ts",
  "py", "java", "cpp", "c", "cs", "php"
]


const normalizeFileType = (type: string): string => {
  return type.startsWith('.') ? type.slice(1).toLowerCase() : type.toLowerCase()
}


const isValidFileType = (type: string): boolean => {
  const normalized = normalizeFileType(type)
  return VALID_FILE_TYPES.includes(normalized)
}

const OnFormSubmissionUI: React.FC<OnFormSubmissionUIProps> = ({
  isVisible = true,
  onBack,
  onClose,
  onSave,
  initialConfig,
  toolData,
  toolId,
  showBackButton = false,
  builder = true,
}) => {
  const initialFieldId = crypto.randomUUID()

  
  const getInitialFormConfig = (): FormConfig => {
    
    const formTitle = toolData?.value?.title || initialConfig?.title || ""
    const formDescription = toolData?.value?.description || initialConfig?.description || ""
    
    
    let convertedFields: FormField[] = []
    
    if (toolData?.value?.fields && Array.isArray(toolData.value.fields)) {
      convertedFields = toolData.value.fields.map((field: any) => ({
        id: field.id || crypto.randomUUID(),
        name: field.name || field.label || field.id || "Field",
        placeholder: field.placeholder || "",
        type: field.type === "upload" ? "file" : field.type || "text",
        options: field.options || [],
        fileTypes: field.filetypes || field.fileTypes || (field.type === "file" || field.type === "upload" ? ["pdf", "doc", "docx", "txt", "jpg", "png"] : []),
        required: field.required !== undefined ? field.required : true,
        maxSize: field.maxSize || "",
      }))
    }

    if (initialConfig || toolData?.value) {
      return {
        title: formTitle,
        description: formDescription,
        fields:
          convertedFields.length > 0
            ? convertedFields
            : [
                {
                  id: initialFieldId,
                  name: "Field 1",
                  placeholder: "",
                  type: "file",
                  required: true,
                },
              ],
      }
    }

    return (
      initialConfig || {
        title: "",
        description: "",
        fields: [
          {
            id: initialFieldId,
            name: "Field 1",
            placeholder: "",
            type: "file",
            required: true,
          },
        ],
      }
    )
  }

  const [formConfig, setFormConfig] = useState<FormConfig>(
    getInitialFormConfig(),
  )

  
  React.useEffect(() => {
    setFormConfig(getInitialFormConfig())
  }, [initialConfig, toolData])

  const [collapsedFieldIds, setCollapsedFieldIds] = useState<Set<string>>(
    new Set(),
  )
  const [uploadedFiles, setUploadedFiles] = useState<{
    [fieldId: string]: File[]
  }>({})
  const [newFileType, setNewFileType] = useState("")

  
  React.useEffect(() => {
    setFormConfig(prev => ({
      ...prev,
      fields: prev.fields.map(field => ({
        ...field,
        fileTypes: field.type === "file" && (!field.fileTypes || field.fileTypes.length === 0) 
          ? ["pdf", "doc", "docx", "txt", "jpg", "png"] 
          : field.fileTypes,
        required: true
      }))
    }))
  }, [])

  const handleSave = async () => {
    try {
      
      console.log("tool id here",toolId)
      if (toolId && !builder) {
        const updatedToolData = {
          type: "form",
          value: {
            title: formConfig.title,
            description: formConfig.description,
            fields: formConfig.fields.map((field) => ({
              id: field.id,
              label: field.name,
              type: field.type,
              required: field.required,
              placeholder: field.placeholder,
              fileTypes: field.fileTypes,
              options: field.options,
              maxSize: field.maxSize,
            })),
          },
          config: {
            ...toolData?.config,
            submitText: "Submit Form",
            validation: "strict",
          },
        }

        const apiResponse = await workflowToolsAPI.updateTool(toolId, updatedToolData)
        console.log("tool id here 2",toolId)
        console.log("Form tool updated successfully, API response:", apiResponse)
        
        
        console.log("Form configuration saved:", formConfig)
        onSave?.(formConfig, apiResponse)
      } else {
        
        console.log("Form configuration saved:", formConfig)
        onSave?.(formConfig)
      }
    } catch (error) {
      console.error("Failed to save form configuration:", error)
      
      onSave?.(formConfig)
    }
  }

  const updateField = (fieldId: string, updates: Partial<FormField>) => {
    setFormConfig((prev) => ({
      ...prev,
      fields: prev.fields.map((field) =>
        field.id === fieldId ? { ...field, ...updates } : field,
      ),
    }))
  }

  const removeField = (fieldId: string) => {
    setFormConfig((prev) => ({
      ...prev,
      fields: prev.fields.filter((field) => field.id !== fieldId),
    }))
    
    setCollapsedFieldIds((prev) => {
      const newSet = new Set(prev)
      newSet.delete(fieldId)
      return newSet
    })
  }



  const removeFile = (fieldId: string, fileIndex: number) => {
    setUploadedFiles((prev) => ({
      ...prev,
      [fieldId]: prev[fieldId]?.filter((_, index) => index !== fileIndex) || [],
    }))
  }

  const addFileType = (fieldId: string, fileType: string) => {
    const normalized = normalizeFileType(fileType.trim())
    const currentFileTypes = getFieldById(fieldId)?.fileTypes || []
    
    if (normalized && isValidFileType(normalized) && !currentFileTypes.includes(normalized)) {
      updateField(fieldId, {
        fileTypes: [...currentFileTypes, normalized]
      })
      setNewFileType("")
    }
  }

  const removeFileType = (fieldId: string, typeToRemove: string) => {
    updateField(fieldId, {
      fileTypes: getFieldById(fieldId)?.fileTypes?.filter(type => type !== typeToRemove) || []
    })
  }

  const getFieldById = (fieldId: string) => {
    return formConfig.fields.find(field => field.id === fieldId)
  }

  const handleFileTypeKeyDown = (e: React.KeyboardEvent, fieldId: string) => {
    if (e.key === "Enter" && newFileType.trim()) {
      e.preventDefault()
      addFileType(fieldId, newFileType)
    }
  }

  const getFieldTypeIcon = (type: string) => {
    switch (type) {
      case "file":
        return <Upload className="w-4 h-4" />
      case "text":
      case "email":
      case "number":
        return <FileText className="w-4 h-4" />
      case "textarea":
        return <FileText className="w-4 h-4" />
      case "dropdown":
        return <ChevronDown className="w-4 h-4" />
      default:
        return <FileText className="w-4 h-4" />
    }
  }

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Panel Header */}
      <div
        className="flex items-center border-b"
        style={{
          display: "flex",
          padding: "20px",
          alignItems: "center",
          gap: "10px",
          alignSelf: "stretch",
          borderBottom: "1px solid var(--gray-300, #E4E6E7)",
        }}
      >
        {showBackButton && (
          <button
            onClick={onBack}
            className="flex items-center justify-center"
            style={{
              width: "24px",
              height: "24px",
              padding: "0",
              border: "none",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            <BackArrowIcon width={24} height={24} />
          </button>
        )}

        <h2
          className="flex-1 text-gray-900 dark:text-gray-100"
          style={{
            fontFamily: "Inter",
            fontSize: "16px",
            fontStyle: "normal",
            fontWeight: "600",
            lineHeight: "normal",
            letterSpacing: "-0.16px",
            textTransform: "capitalize",
          }}
        >
          On form submission
        </h2>

        <button
          onClick={onClose || onBack}
          className="flex items-center justify-center w-6 h-6 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
          style={{
            padding: "0",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <CloseIcon width={24} height={24} />
        </button>
      </div>

      {/* Panel Content */}
      <div className="flex-1 overflow-y-auto p-6 dark:bg-gray-900 flex flex-col">
        <div className="space-y-4 flex-1">
          {/* Form Title */}
          <div className="space-y-2">
            <Label
              htmlFor="form-title"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Form Title
            </Label>
            <Input
              id="form-title"
              value={formConfig.title}
              onChange={(e) =>
                setFormConfig((prev) => ({ ...prev, title: e.target.value }))
              }
              placeholder="type here"
              className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
            />
          </div>

          {/* Form Description */}
          <div className="space-y-2">
            <Label
              htmlFor="form-description"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Form Description
            </Label>
            <Textarea
              id="form-description"
              value={formConfig.description}
              onChange={(e) =>
                setFormConfig((prev) => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
              placeholder="type here"
              className="w-full min-h-[80px] resize-none dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 placeholder-gray-400 dark:placeholder-gray-400"
            />
          </div>

          {/* Divider */}
          <div className="w-full h-px bg-slate-200 dark:bg-gray-700"></div>

          {/* Form Elements */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Form Elements
            </Label>

            <div className="space-y-3">
              {formConfig.fields.map((field) => (
                <div
                  key={field.id}
                  className="border border-slate-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                >
                  {/* Field Header */}
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer"
                    onClick={() =>
                      setCollapsedFieldIds((prev) => {
                        const newSet = new Set(prev)
                        if (newSet.has(field.id)) {
                          newSet.delete(field.id) 
                        } else {
                          newSet.add(field.id) 
                        }
                        return newSet
                      })
                    }
                  >
                    <div className="flex items-center gap-3">
                      {getFieldTypeIcon(field.type)}
                      <span className="font-medium text-slate-900 dark:text-gray-300">
                        {field.name}
                      </span>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-500 dark:text-gray-400 transition-transform ${
                        !collapsedFieldIds.has(field.id) ? "rotate-180" : ""
                      }`}
                    />
                  </div>

                  {/* Field Configuration */}
                  {!collapsedFieldIds.has(field.id) && (
                    <div className="border-t border-slate-200 dark:border-gray-700 p-4 space-y-4">
                      {/* Field Name */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                          Field Name
                        </Label>
                        <Input
                          value={field.name}
                          onChange={(e) =>
                            updateField(field.id, { name: e.target.value })
                          }
                          placeholder="type here"
                          className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
                        />
                      </div>

                      {/* Input Type */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                          Input Type
                        </Label>
                        <Dropdown
                          options={[
                            { value: "file", label: "File" },
                            { value: "text", label: "Text" },
                            { value: "email", label: "Email" },
                            { value: "number", label: "Number" },
                            { value: "textarea", label: "Textarea" },
                            { value: "dropdown", label: "Dropdown" }
                          ]}
                          value={field.type}
                          onSelect={(value) =>
                            updateField(field.id, {
                              type: value as FormField["type"],
                            })
                          }
                          placeholder="Select input type"
                          variant="outline"
                          size="md"
                          rounded="6px"
                          border="1px solid #E2E8F0"
                          fontSize="text-sm"
                        />
                      </div>

                      {/* Field Type Specific Content */}
                      {field.type === "file" ? (
                        <div className="space-y-4">
                          {/* Uploaded Files Display */}
                          {uploadedFiles[field.id] &&
                            uploadedFiles[field.id].length > 0 && (
                              <div className="space-y-2">
                                <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                                  Uploaded Files
                                </Label>
                                <div className="space-y-2">
                                  {uploadedFiles[field.id].map(
                                    (file, index) => (
                                      <div
                                        key={index}
                                        className="flex items-center justify-between p-2 bg-slate-50 dark:bg-gray-700 rounded-md"
                                      >
                                        <div className="flex items-center gap-2">
                                          <File className="w-4 h-4 text-slate-500 dark:text-gray-400" />
                                          <span className="text-sm text-slate-700 dark:text-gray-300 truncate">
                                            {file.name}
                                          </span>
                                          <span className="text-xs text-slate-500 dark:text-gray-400">
                                            ({(file.size / 1024).toFixed(1)} KB)
                                          </span>
                                        </div>
                                        <button
                                          onClick={() =>
                                            removeFile(field.id, index)
                                          }
                                          className="p-1 hover:bg-slate-200 dark:hover:bg-gray-600 rounded transition-colors"
                                        >
                                          <X className="w-4 h-4 text-slate-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" />
                                        </button>
                                      </div>
                                    ),
                                  )}
                                </div>
                              </div>
                            )}

                          {/* File Type Configuration */}
                          <div className="space-y-3">
                            <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                              Allowed File Types
                            </Label>
                            
                            {/* Tag input box with pills inside */}
                            <div className="relative">
                              <div className="min-h-[40px] w-full px-3 py-2 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-600 rounded-md flex flex-wrap items-center gap-1 focus-within:ring-1 focus-within:ring-slate-400 dark:focus-within:ring-gray-500 focus-within:border-slate-400 dark:focus-within:border-gray-500">
                                {/* Display existing file types as pills inside the input */}
                                {field.fileTypes?.map((fileType, index) => (
                                  <div
                                    key={index}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
                                  >
                                    <span>.{fileType}</span>
                                    <button
                                      onClick={() => removeFileType(field.id, fileType)}
                                      className="hover:bg-black/10 dark:hover:bg-white/10 rounded-full p-0.5"
                                      type="button"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                                
                                {/* Input field for adding new file types */}
                                <input
                                  type="text"
                                  value={newFileType}
                                  onChange={(e) => setNewFileType(e.target.value)}
                                  onKeyDown={(e) => handleFileTypeKeyDown(e, field.id)}
                                  placeholder={field.fileTypes?.length === 0 ? "Enter file type (e.g., pdf, jpg)" : ""}
                                  className="flex-1 min-w-[120px] bg-transparent border-none outline-none text-sm text-slate-900 dark:text-gray-300 placeholder-slate-400 dark:placeholder-gray-500"
                                />
                              </div>
                            </div>
                            
                            <p className="text-xs text-slate-500 dark:text-gray-400">
                              Valid file types: {VALID_FILE_TYPES.slice(0, 10).join(", ")}, and more...
                            </p>
                          </div>
                        </div>
                      ) : field.type === "dropdown" ? (
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                            Dropdown Options (comma-separated)
                          </Label>
                          <Textarea
                            value={field.options?.join(", ") || ""}
                            onChange={(e) =>
                              updateField(field.id, {
                                options: e.target.value
                                  .split(",")
                                  .map((option) => option.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="Option 1, Option 2, Option 3"
                            className="w-full min-h-[60px] resize-none dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                            Placeholder Text
                          </Label>
                          <Input
                            value={field.placeholder}
                            onChange={(e) =>
                              updateField(field.id, {
                                placeholder: e.target.value,
                              })
                            }
                            placeholder="type here"
                            className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
                          />
                        </div>
                      )}


                      {/* Remove Field Button */}
                      {formConfig.fields.length > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeField(field.id)}
                          className="w-full text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          Remove Field
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        
        {/* Save Button - Sticky to bottom */}
        <div className="pt-6 px-0">
          <Button
            onClick={handleSave}
            className="w-full bg-gray-900 hover:bg-gray-900 text-white rounded-full shadow-none"
          >
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  )
}

export default OnFormSubmissionUI
