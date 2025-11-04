import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Form field types
export const formFieldSchema = z.object({
  id: z.string(),
  type: z.enum(["text", "email", "number", "textarea", "select", "radio", "checkbox", "file"]),
  label: z.string(),
  placeholder: z.string().optional(),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(), // For select, radio, checkbox
  validation: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    message: z.string().optional(),
  }).optional(),
  fileValidation: z.object({
    maxSize: z.number().optional(), // in bytes
    allowedTypes: z.array(z.string()).optional(), // MIME types
    message: z.string().optional(),
  }).optional(),
})

// Form tool configuration schema
export const formConfigSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(formFieldSchema),
  submitButtonText: z.string().default("Submit"),
  allowMultipleSubmissions: z.boolean().default(false),
  autoSave: z.boolean().default(false),
})

// Form tool input schema (when form is submitted)
export const formInputSchema = z.object({
  formData: z.record(z.string(), z.any()),
  submittedBy: z.string().optional(),
  submissionId: z.string().optional(),
})

// Form tool output schema
export const formOutputSchema = z.object({
  formData: z.record(z.string(), z.any()),
  submittedAt: z.string(),
  submittedBy: z.string(),
  autoCompleted: z.boolean().default(false),
  validationResults: z.object({
    isValid: z.boolean(),
    errors: z.array(z.string()).default([]),
  }).optional(),
})

export type FormField = z.infer<typeof formFieldSchema>
export type FormConfig = z.infer<typeof formConfigSchema>
export type FormInput = z.infer<typeof formInputSchema>
export type FormOutput = z.infer<typeof formOutputSchema>

// Validation helper functions
const validateFormData = (
  formData: Record<string, any>,
  validationSchema: Record<string, any>
): { isValid: boolean; errors: string[] } => {
  const errors: string[] = []

  for (const [fieldId, rules] of Object.entries(validationSchema)) {
    const value = formData[fieldId]

    // Required field validation
    if (rules.required && (!value || (typeof value === 'string' && value.trim() === ''))) {
      errors.push(`Field '${fieldId}' is required`)
      continue
    }

    // Skip other validations if field is empty and not required
    if (!value) continue

    // Type-specific validation
    if (rules.type === 'email' && typeof value === 'string') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(value)) {
        errors.push(`Field '${fieldId}' must be a valid email address`)
      }
    }

    if (rules.type === 'number') {
      const numValue = Number(value)
      if (isNaN(numValue)) {
        errors.push(`Field '${fieldId}' must be a number`)
      } else {
        if (rules.validation?.min !== undefined && numValue < rules.validation.min) {
          errors.push(`Field '${fieldId}' must be at least ${rules.validation.min}`)
        }
        if (rules.validation?.max !== undefined && numValue > rules.validation.max) {
          errors.push(`Field '${fieldId}' must be at most ${rules.validation.max}`)
        }
      }
    }

    // String length validation
    if (typeof value === 'string' && rules.validation) {
      if (rules.validation.min !== undefined && value.length < rules.validation.min) {
        errors.push(`Field '${fieldId}' must be at least ${rules.validation.min} characters`)
      }
      if (rules.validation.max !== undefined && value.length > rules.validation.max) {
        errors.push(`Field '${fieldId}' must be at most ${rules.validation.max} characters`)
      }
      if (rules.validation.pattern) {
        const regex = new RegExp(rules.validation.pattern)
        if (!regex.test(value)) {
          errors.push(rules.validation.message || `Field '${fieldId}' format is invalid`)
        }
      }
    }

    // File validation
    if (rules.type === 'file' && rules.fileValidation) {
      // File validation would be handled during file upload process
      // This is a placeholder for file validation logic
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

const buildValidationSchema = (fields: FormField[]): Record<string, any> => {
  const schema: Record<string, any> = {}

  for (const field of fields) {
    schema[field.id] = {
      type: field.type,
      required: field.required,
      validation: field.validation,
      fileValidation: field.fileValidation,
    }
  }

  return schema
}

export class FormTool implements WorkflowTool<FormConfig, FormInput, FormOutput> {
  type = ToolType.FORM
  category = ToolCategory.TRIGGER

  async execute(
    input: FormInput,
    config: FormConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<FormOutput>> {
    try {
      // Build validation schema from form definition
      const validationSchema = buildValidationSchema(config.fields)

      // Validate form data
      const validationResults = validateFormData(input.formData, validationSchema)

      if (!validationResults.isValid) {
        return {
          status: "error",
          result: {
            formData: input.formData,
            submittedAt: new Date().toISOString(),
            submittedBy: input.submittedBy || "unknown",
            autoCompleted: false,
            validationResults,
          } as FormOutput,
        }
      }

      // Process successful form submission
      const output: FormOutput = {
        formData: input.formData,
        submittedAt: new Date().toISOString(),
        submittedBy: input.submittedBy || "api",
        autoCompleted: false,
        validationResults,
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          formData: input.formData || {},
          submittedAt: new Date().toISOString(),
          submittedBy: input.submittedBy || "unknown",
          autoCompleted: false,
          validationResults: {
            isValid: false,
            errors: [`Form processing failed: ${error instanceof Error ? error.message : String(error)}`],
          },
        } as FormOutput,
      }
    }
  }

  // For form tools, this method returns the form definition for user input
  async getFormDefinition(config: FormConfig): Promise<{
    formDefinition: FormConfig
    message: string
  }> {
    return {
      formDefinition: config,
      message: "User input required - form needs to be filled out",
    }
  }

  validateInput(input: unknown): input is FormInput {
    return formInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is FormConfig {
    return formConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return formInputSchema
  }

  getConfigSchema() {
    return formConfigSchema
  }

  getDefaultConfig(): FormConfig {
    return {
      fields: [
        {
          id: "default_field",
          type: "text",
          label: "Input",
          required: true,
        },
      ],
      submitButtonText: "Submit",
      allowMultipleSubmissions: false,
      autoSave: false,
    }
  }
}