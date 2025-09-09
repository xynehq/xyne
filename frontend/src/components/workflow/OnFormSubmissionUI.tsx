import React, { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FileText, ChevronDown, Upload, File, X } from "lucide-react"
import { BackArrowIcon, CloseIcon } from "./WorkflowIcons"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface OnFormSubmissionUIProps {
  onBack: () => void
  onSave?: (formConfig: FormConfig) => void
  initialConfig?: FormConfig
  toolData?: any // Tool data from the backend
  toolId?: string // Tool ID for API updates
  stepData?: any // Step data for titles
}

interface FormField {
  id: string
  name: string
  placeholder: string
  type: "text" | "email" | "file" | "number" | "textarea" | "dropdown"
  originalType?: string // Track the original backend type
  options?: string[] // For dropdown fields
  fileTypes?: string[] // For file upload validation
  required?: boolean
  maxSize?: string
}

export interface FormConfig {
  title: string
  description: string
  fields: FormField[]
}

const OnFormSubmissionUI: React.FC<OnFormSubmissionUIProps> = ({
  onBack,
  onSave,
  initialConfig,
  toolData,
  toolId,
  stepData,
}) => {
  const initialFieldId = crypto.randomUUID()

  // Parse toolData to populate form fields
  const getInitialFormConfig = (): FormConfig => {
    if (toolData?.value) {
      const { title = "", description = "", fields = [] } = toolData.value

      // Convert backend fields to our FormField interface
      const convertedFields: FormField[] = fields.map((field: any) => ({
        id: field.id || crypto.randomUUID(),
        name: field.label || field.name || field.id || "Field",
        placeholder: field.placeholder || "",
        type: field.type === "upload" ? "file" : field.type || "text",
        options: field.options || [],
        fileTypes: field.fileTypes || [],
        required: field.required || false,
        maxSize: field.maxSize || "",
      }))

      return {
        title,
        description,
        fields:
          convertedFields.length > 0
            ? convertedFields
            : [
                {
                  id: initialFieldId,
                  name: "Field 1",
                  placeholder: "",
                  type: "file",
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
          },
        ],
      }
    )
  }

  const [formConfig, setFormConfig] = useState<FormConfig>(
    getInitialFormConfig(),
  )

  const [collapsedFieldIds, setCollapsedFieldIds] = useState<Set<string>>(
    new Set(),
  )
  const [uploadedFiles, setUploadedFiles] = useState<{
    [fieldId: string]: File[]
  }>({})
  const fileInputRefs = useRef<{ [fieldId: string]: HTMLInputElement | null }>(
    {},
  )

  const handleSave = async () => {
    try {
      // If we have a toolId, update the tool via API
      if (toolId) {
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
          stepName: formConfig.title || "Form Submission",
          stepDescription: formConfig.description || "Upload a file in formats such as PDF, DOCX, or JPG.",
        }

        await workflowToolsAPI.updateTool(toolId, updatedToolData)
        console.log("Form tool updated successfully")
      }

      // Call the parent save handler
      onSave?.(formConfig)
    } catch (error) {
      console.error("Failed to save form configuration:", error)
      // Still call the parent handler even if API call fails
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
    // Remove from collapsed set if it was there
    setCollapsedFieldIds((prev) => {
      const newSet = new Set(prev)
      newSet.delete(fieldId)
      return newSet
    })
  }

  const addField = () => {
    const newField: FormField = {
      id: crypto.randomUUID(),
      name: `Field ${formConfig.fields.length + 1}`,
      placeholder: "",
      type: "text",
      required: false,
    }

    setFormConfig((prev) => ({
      ...prev,
      fields: [...prev.fields, newField],
    }))

    // Automatically expand the new field for configuration
    setCollapsedFieldIds((prev) => {
      const newSet = new Set(prev)
      // Don't add the new field to collapsed set, so it starts expanded
      return newSet
    })
  }

  const handleFileUpload = (
    fieldId: string,
    files: FileList,
    allowedTypes: string[] = [],
  ) => {
    const validFiles: File[] = []
    const invalidFiles: string[] = []

    Array.from(files).forEach((file) => {
      if (allowedTypes.length > 0) {
        const fileExtension = "." + file.name.split(".").pop()?.toLowerCase()
        const isValidType = allowedTypes.some(
          (type) =>
            type.toLowerCase() === fileExtension ||
            file.type.includes(type.toLowerCase().replace(".", "")),
        )

        if (isValidType) {
          validFiles.push(file)
        } else {
          invalidFiles.push(file.name)
        }
      } else {
        validFiles.push(file)
      }
    })

    if (invalidFiles.length > 0) {
      alert(
        `Invalid file types: ${invalidFiles.join(", ")}. Allowed types: ${allowedTypes.join(", ")}`,
      )
    }

    if (validFiles.length > 0) {
      setUploadedFiles((prev) => ({
        ...prev,
        [fieldId]: [...(prev[fieldId] || []), ...validFiles],
      }))
    }
  }

  const removeFile = (fieldId: string, fileIndex: number) => {
    setUploadedFiles((prev) => ({
      ...prev,
      [fieldId]: prev[fieldId]?.filter((_, index) => index !== fileIndex) || [],
    }))
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
      className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out w-[400px]`}
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

        <h2
          className="flex-1"
          style={{
            alignSelf: "stretch",
            color: "var(--gray-900, #181B1D)",
            fontFamily: "Inter",
            fontSize: "16px",
            fontStyle: "normal",
            fontWeight: "600",
            lineHeight: "normal",
            letterSpacing: "-0.16px",
            textTransform: "capitalize",
          }}
        >
          {stepData?.step?.name || toolData?.name || "On form submission"}
        </h2>

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
          <CloseIcon width={24} height={24} />
        </button>
      </div>

      {/* Panel Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {/* Form Title */}
          <div className="space-y-2">
            <Label
              htmlFor="form-title"
              className="text-sm font-medium text-slate-700"
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
              className="w-full"
            />
          </div>

          {/* Form Description */}
          <div className="space-y-2">
            <Label
              htmlFor="form-description"
              className="text-sm font-medium text-slate-700"
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
              className="w-full min-h-[80px] resize-none"
            />
          </div>

          {/* Divider */}
          <div className="w-full h-px bg-slate-200"></div>

          {/* Form Elements */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-slate-700">
              Form Elements
            </Label>

            <div className="space-y-3">
              {formConfig.fields.map((field) => (
                <div
                  key={field.id}
                  className="border border-slate-200 rounded-lg bg-white"
                >
                  {/* Field Header */}
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50"
                    onClick={() =>
                      setCollapsedFieldIds((prev) => {
                        const newSet = new Set(prev)
                        if (newSet.has(field.id)) {
                          newSet.delete(field.id) // Expand (remove from collapsed)
                        } else {
                          newSet.add(field.id) // Collapse (add to collapsed)
                        }
                        return newSet
                      })
                    }
                  >
                    <div className="flex items-center gap-3">
                      {getFieldTypeIcon(field.type)}
                      <span className="font-medium text-slate-900">
                        {field.name}
                      </span>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-500 transition-transform ${
                        !collapsedFieldIds.has(field.id) ? "rotate-180" : ""
                      }`}
                    />
                  </div>

                  {/* Field Configuration */}
                  {!collapsedFieldIds.has(field.id) && (
                    <div className="border-t border-slate-200 p-4 space-y-4">
                      {/* Field Name */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">
                          Field Name
                        </Label>
                        <Input
                          value={field.name}
                          onChange={(e) =>
                            updateField(field.id, { name: e.target.value })
                          }
                          placeholder="type here"
                          className="w-full"
                        />
                      </div>

                      {/* Field Type Specific Content */}
                      {field.type === "file" ? (
                        <div className="space-y-4">
                          {/* File Upload Area - Commented out when type is 'file' */}
                          {false && (
                            <div className="space-y-2">
                              <Label className="text-sm font-medium text-slate-700">
                                File Upload
                              </Label>
                              <div
                                className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-slate-400 transition-colors cursor-pointer"
                                onClick={() =>
                                  fileInputRefs.current[field.id]?.click()
                                }
                              >
                                <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                                <p className="text-sm text-slate-600">
                                  Click to upload files
                                  {field.fileTypes &&
                                    field.fileTypes.length > 0 && (
                                      <span className="block text-xs text-slate-500 mt-1">
                                        Allowed: {field.fileTypes.join(", ")}
                                      </span>
                                    )}
                                </p>
                                <input
                                  ref={(el) =>
                                    (fileInputRefs.current[field.id] = el)
                                  }
                                  type="file"
                                  multiple
                                  accept={field.fileTypes?.join(",") || ""}
                                  onChange={(e) =>
                                    e.target.files &&
                                    handleFileUpload(
                                      field.id,
                                      e.target.files,
                                      field.fileTypes,
                                    )
                                  }
                                  className="hidden"
                                />
                              </div>
                            </div>
                          )}

                          {/* Uploaded Files Display - Commented out when type is 'file' */}
                          {false && uploadedFiles[field.id] &&
                            uploadedFiles[field.id].length > 0 && (
                              <div className="space-y-2">
                                <Label className="text-sm font-medium text-slate-700">
                                  Uploaded Files
                                </Label>
                                <div className="space-y-2">
                                  {uploadedFiles[field.id].map(
                                    (file, index) => (
                                      <div
                                        key={index}
                                        className="flex items-center justify-between p-2 bg-slate-50 rounded-md"
                                      >
                                        <div className="flex items-center gap-2">
                                          <File className="w-4 h-4 text-slate-500" />
                                          <span className="text-sm text-slate-700 truncate">
                                            {file.name}
                                          </span>
                                          <span className="text-xs text-slate-500">
                                            ({(file.size / 1024).toFixed(1)} KB)
                                          </span>
                                        </div>
                                        <button
                                          onClick={() =>
                                            removeFile(field.id, index)
                                          }
                                          className="p-1 hover:bg-slate-200 rounded transition-colors"
                                        >
                                          <X className="w-4 h-4 text-slate-400 hover:text-red-500" />
                                        </button>
                                      </div>
                                    ),
                                  )}
                                </div>
                              </div>
                            )}

                          {/* File Type Configuration */}
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-slate-700">
                              Allowed File Types (comma-separated)
                            </Label>
                            <Input
                              value={field.fileTypes?.join(", ") || ""}
                              onChange={(e) =>
                                updateField(field.id, {
                                  fileTypes: e.target.value
                                    .split(",")
                                    .map((type) => type.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder=".pdf, .docx, .jpg"
                              className="w-full"
                            />
                          </div>
                        </div>
                      ) : field.type === "dropdown" ? (
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-slate-700">
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
                            className="w-full min-h-[60px] resize-none"
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-slate-700">
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
                            className="w-full"
                          />
                        </div>
                      )}

                      {/* Element Type */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">
                          Element Type
                        </Label>
                        <div className="relative">
                          <select
                            value={field.type}
                            onChange={(e) =>
                              updateField(field.id, {
                                type: e.target.value as FormField["type"],
                              })
                            }
                            className="w-full h-9 px-3 py-1 bg-white border border-slate-200 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400 appearance-none cursor-pointer"
                            style={{
                              background: "white",
                              color: "#1f2937",
                            }}
                          >
                            <option
                              value="file"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              File
                            </option>
                            <option
                              value="text"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              Text
                            </option>
                            <option
                              value="email"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              Email
                            </option>
                            <option
                              value="number"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              Number
                            </option>
                            <option
                              value="textarea"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              Textarea
                            </option>
                            <option
                              value="dropdown"
                              style={{ background: "white", color: "#1f2937" }}
                            >
                              Dropdown
                            </option>
                          </select>
                          <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                        </div>
                      </div>

                      {/* Required Field Checkbox */}
                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id={`required-${field.id}`}
                          checked={field.required || false}
                          onChange={(e) =>
                            updateField(field.id, {
                              required: e.target.checked,
                            })
                          }
                          className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <Label
                          htmlFor={`required-${field.id}`}
                          className="text-sm font-medium text-slate-700"
                        >
                          Required field
                        </Label>
                      </div>

                      {/* Remove Field Button */}
                      {formConfig.fields.length > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeField(field.id)}
                          className="w-full text-red-600 border-red-200 hover:bg-red-50"
                        >
                          Remove Field
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Add Field Button */}
              <Button
                variant="outline"
                onClick={addField}
                className="w-full border-dashed border-slate-300 hover:border-slate-400 text-slate-600 hover:text-slate-700 bg-transparent hover:bg-slate-50"
              >
                <svg
                  className="w-4 h-4 mr-2"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Add Field
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Panel Footer */}
      <div className="px-4 py-3 border-t border-slate-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <Button
          onClick={handleSave}
          className="w-full bg-black hover:bg-gray-800 text-white"
        >
          Save Configuration
        </Button>
      </div>
    </div>
  )
}

export default OnFormSubmissionUI
