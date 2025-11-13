/**
 * Utility functions for workflow operations
 */

/**
 * Interface for workflow step data
 */
export interface WorkflowStepData {
  prevStepIds?: string[]
  workflowStepTemplateId?: string
  toolExecIds?: string[]
  [key: string]: any
}

/**
 * Interface for workflow execution data
 */
export interface WorkflowExecutionData {
  stepExecutions?: WorkflowStepData[]
  toolExecutions?: Array<{
    id: string
    result?: any
    [key: string]: any
  }>
  [key: string]: any
}

/**
 * Get the output/results from the previous step in a workflow execution
 * 
 * @param stepData - Current step data containing prevStepIds
 * @param workflowData - Full workflow execution data
 * @returns Array of results from previous step tools, or null if no previous step or no results
 */
export const getPreviousStepOutput = (
  stepData: WorkflowStepData | null | undefined,
  workflowData: WorkflowExecutionData | null | undefined
): any[] | null => {
  // Validate inputs
  if (!stepData?.prevStepIds || stepData.prevStepIds.length === 0 || !workflowData) {
    return null
  }

  try {
    // Get the first previous step (assuming single previous step for simplicity)
    const prevStepTemplateId = stepData.prevStepIds[0]

    // Find previous step execution by matching workflowStepTemplateId
    const prevStep = workflowData.stepExecutions?.find(
      (s: any) => s.workflowStepTemplateId === prevStepTemplateId,
    )

    if (!prevStep) {
      console.warn('Previous step not found for template ID:', prevStepTemplateId)
      return null
    }

    // Get previous step's tool outputs
    const prevStepTools =
      workflowData.toolExecutions?.filter((toolExec: any) =>
        prevStep.toolExecIds?.includes(toolExec.id),
      ) || []

    if (prevStepTools.length === 0) {
      console.warn('No tool executions found for previous step:', prevStep.id || prevStepTemplateId)
      return null
    }

    // Return the results from all previous step tools
    const results = prevStepTools
      .map((tool: any) => tool.result)
      .filter(Boolean)

    console.log('Found previous step results:', results.length, 'results')
    return results.length > 0 ? results : null
  } catch (error) {
    console.error('Error getting previous step output:', error)
    return null
  }
}

/**
 * Check if a workflow step has previous steps
 * 
 * @param stepData - Step data to check
 * @returns True if step has previous steps
 */
export const hasPreviousSteps = (stepData: WorkflowStepData | null | undefined): boolean => {
  return Boolean(stepData?.prevStepIds && stepData.prevStepIds.length > 0)
}

/**
 * Get file data from workflow step results
 * Looks for common file data patterns in step results
 * 
 * @param stepResults - Results from previous step
 * @returns File data object or null if not found
 */
export const getFileDataFromStepResults = (stepResults: any[] | null): any | null => {
  if (!stepResults || stepResults.length === 0) {
    return null
  }

  for (const result of stepResults) {
    // Check multiple possible file paths from previous steps
    let fileData = null
    
    if (result.formData?.document_file) {
      fileData = result.formData.document_file
    } else if (result.result?.formData?.document_file) {
      fileData = result.result.formData.document_file
    }
    
    if (fileData) {
      console.log('Found file data in step results:', fileData)
      return fileData
    }
  }

  return null
}