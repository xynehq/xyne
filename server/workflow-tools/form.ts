import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"

export class FormTool implements WorkflowTool {
  type = ToolType.FORM
  category = ToolCategory.ACTION
  triggerIfActive = false

  inputSchema = z.object({
    formData: z.record(z.string(), z.any()).optional(),
    previousStepData: z.record(z.string(), z.any()).optional()
  })

  outputSchema = z.object({
    form_id: z.string(),
    form_title: z.string(),
    form_description: z.string(),
    fields: z.array(z.any()),
    submitted: z.boolean(),
    submission_data: z.record(z.string(), z.any()).optional()
  })

  configSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      label: z.string(),
      required: z.boolean().optional(),
      options: z.array(z.string()).optional()
    })).default([])
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      return {
        status: "awaiting_user_input",
        result: {
          form_id: `form_${Date.now()}`,
          form_title: config.title || "Form Input Required",
          form_description: config.description || "Please fill out the form",
          fields: config.fields || [],
          submitted: false,
          submission_data: input.formData || {},
        },
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          form_id: "",
          form_title: config.title || "Form Input Required",
          form_description: config.description || "Please fill out the form",
          fields: [],
          submitted: false,
          submission_data: {},
          error: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }
}