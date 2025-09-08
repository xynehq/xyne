import React, { createContext, useState, ReactNode, useEffect } from "react"
import { Flow, Step } from "./Types"

interface FlowContextProps {
  flow: Flow | null
  setFlow: (flow: Flow | null) => void
  activeSubStep: Step | null
  setActiveSubStep: (step: Step | null) => void
}

const defaultValue: FlowContextProps = {
  flow: null,
  setFlow: () => {},
  activeSubStep: null,
  setActiveSubStep: () => {},
}

export const FlowContext = createContext<FlowContextProps>(defaultValue)

interface ProviderProps {
  children: ReactNode
}

export const FlowProvider: React.FC<ProviderProps> = ({ children }) => {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [activeSubStep, setActiveSubStep] = useState<Step | null>(null)

  // Load flow and activeSubStep from localStorage on mount
  useEffect(() => {
    try {
      const savedFlow = localStorage.getItem("flow_data")
      const savedActiveSubStep = localStorage.getItem("active_sub_step")

      if (savedFlow) {
        const parsedFlow = JSON.parse(savedFlow)
        console.log("FlowProvider: Loading flow from localStorage:", parsedFlow)
        setFlow(parsedFlow)
      }

      if (savedActiveSubStep) {
        const parsedActiveSubStep = JSON.parse(savedActiveSubStep)
        console.log(
          "FlowProvider: Loading activeSubStep from localStorage:",
          parsedActiveSubStep,
        )
        setActiveSubStep(parsedActiveSubStep)
      }
    } catch (error) {
      console.error("Error loading flow data from localStorage:", error)
      // Clear corrupted data
      localStorage.removeItem("flow_data")
      localStorage.removeItem("active_sub_step")
    }
  }, [])

  const setFlowWithLog = (newFlow: Flow | null) => {
    console.log("FlowProvider: Setting flow to:", newFlow)
    setFlow(newFlow)

    // Save to localStorage
    if (newFlow) {
      localStorage.setItem("flow_data", JSON.stringify(newFlow))
    } else {
      localStorage.removeItem("flow_data")
    }
  }

  const setActiveSubStepWithLog = (newStep: Step | null) => {
    console.log("FlowProvider: Setting activeSubStep to:", newStep)
    setActiveSubStep(newStep)

    // Save to localStorage
    if (newStep) {
      localStorage.setItem("active_sub_step", JSON.stringify(newStep))
    } else {
      localStorage.removeItem("active_sub_step")
    }
  }

  return (
    <FlowContext.Provider
      value={{
        flow,
        setFlow: setFlowWithLog,
        activeSubStep,
        setActiveSubStep: setActiveSubStepWithLog,
      }}
    >
      {children}
    </FlowContext.Provider>
  )
}
