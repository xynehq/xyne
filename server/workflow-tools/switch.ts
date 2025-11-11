import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext,defaultToolConfig } from "./types"
import { z } from "zod"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"


const Logger = getLogger(Subsystem.ExecutionEngine)

export class SwitchTool implements WorkflowTool {
  type = ToolType.SWITCH
  category = ToolCategory.SYSTEM
  private operators = ["==", "!=", ">", "<", ">=", "<=", "contains", "startsWith", "endsWith"]
  private mode = ["all", "one", "multiple"]
  defaultConfig:defaultToolConfig = {
    inputCount: 1,
    outputCount: 1, // Variable output based on conditions
    options: {
      outputCount:{
        type: "number",
        default: 1,
        limit: 5,
        optional: false
      },
      mode: {
        type: "select",
        default:"one",
        values: this.mode,
        optional: false
      },
      operators: {
        type: "array",
        default: ["==",">"],
        values: this.operators,
        optional: true
      },
      conditions: {
        type: "object",
        default: {},
        optional: false
      }
    }
  }


  configSchema = z.object({
    mode: z.enum(["all", "one", "multiple"]).default("one"),
    operators: z.array(z.string()).default(["==", "!=", ">", "<", ">=", "<=", "contains", "startsWith", "endsWith"]),
    conditions: z.record(z.string(), z.object({
      val1: z.string(), // Input key path like "input.fieldName"
      val2: z.any(), // Value to compare against
      operator: z.string()
    }))
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      Logger.info(`Executing SwitchTool with config: ${JSON.stringify(config)}`)
      Logger.info(`Input data: ${JSON.stringify(input)}`)
      const { mode = "one", conditions = {} } = config
      const results: Record<string, any> = {}

      // Helper function to extract value from input using dot notation
      const extractValue = (path: string, inputData: Record<string, any>): any => {
        if (path.startsWith("input.")) {
          const keyPath = path.substring(6) // Remove "input." prefix
          return this.getNestedValue(inputData, keyPath)
        }
        return path
      }

      // Helper function to evaluate condition
      const evaluateCondition = (val1: any, operator: string, val2: any): boolean => {
        Logger.info(`Evaluating condition: ${val1} ${operator} ${val2}`)
        switch (operator) {
          case "==":
            return val1 == val2
          case "!=":
            return val1 != val2
          case ">":
            return Number(val1) > Number(val2)
          case "<":
            return Number(val1) < Number(val2)
          case ">=":
            return Number(val1) >= Number(val2)
          case "<=":
            return Number(val1) <= Number(val2)
          case "contains":
            return String(val1).includes(String(val2))
          case "startsWith":
            return String(val1).startsWith(String(val2))
          case "endsWith":
            return String(val1).endsWith(String(val2))
          default:
            throw new Error(`Unsupported operator: ${operator}`)
        }
      }

      // Process each condition branch
      const evaluatedBranches: string[] = []
      
      for (const [branchKey, condition] of Object.entries(conditions)) {
        const { val1: val1Path, val2, operator } = condition as any
        
        // Validate operator
        if (!this.operators.includes(operator)) {
          throw new Error(`Invalid operator '${operator}'. Supported operators: ${this.operators.join(", ")}`)
        }

        // Extract value from input
        const val1 = extractValue(val1Path, input)
        
        // Evaluate condition
        const conditionMet = evaluateCondition(val1, operator, val2)
        
        if (conditionMet) {
          evaluatedBranches.push(branchKey)
          results[branchKey] = {
            status: ToolExecutionStatus.COMPLETED,
            data: input,
            condition: {
              val1,
              operator,
              val2,
              result: true
            }
          }
        }
      }

      // Handle different modes - return either result or nextStepRoutes
      // const { outRoutes = {} } = config
      
      switch (mode) {
        case "all":
          // Return input as result, no routing
          return {
            status: ToolExecutionStatus.COMPLETED,
            output: input,
            metadata: {
              mode,
              totalConditions: Object.keys(conditions).length,
              matchedConditions: evaluatedBranches.length,
              matchedBranches: evaluatedBranches
            }
          }

        case "one":
        case "multiple":
          // Create nextStepRoutes with out1, out2, etc. structure
          const nextStepRoutes:string[] = []
          const branchesToRoute = mode === "one" ? 
            (evaluatedBranches.length > 0 ? [evaluatedBranches[0]] : []) : 
            evaluatedBranches

          return {
            status: ToolExecutionStatus.COMPLETED,
            output: input,
            nextStepRoutes:branchesToRoute,
            metadata: {
              mode,
              totalConditions: Object.keys(conditions).length,
              matchedConditions: evaluatedBranches.length,
              matchedBranches: evaluatedBranches
            }
          }

        default:
          throw new Error(`Invalid mode '${mode}'. Supported modes: all, one, multiple`)
      }

    } catch (error) {
      Logger.error(`SwitchTool execution failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: ToolExecutionStatus.FAILED,
        output: {
          error: error instanceof Error ? error.message : "Unknown error occurred"
        }
      }
    }
  }

  // Helper method to get nested value from object using dot notation
  private getNestedValue(obj: Record<string, any>, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined
    }, obj)
  }
}