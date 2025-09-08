import {
  Status,
  Step,
  Flow,
  LegacyFlow,
  StepGeneratorData,
  ComponentListData,
  SerialComponents,
} from "./Types"
import { defaultStep } from "./Default"

export function padWithZero(value: number): string {
  if (value < 10) {
    return "0" + value.toString()
  } else {
    return value.toString()
  }
}

export function parseTime(time: string): [number, number, number] {
  const regex = /^([0-9]+):([0-5][0-9]):([0-5][0-9])$/
  const result = regex.exec(time)

  const getRegexRes = (
    regexResult: RegExpExecArray | null,
    index: number,
  ): number | undefined => {
    if (!regexResult || !regexResult[index]) {
      return undefined
    }
    const parsed = parseInt(regexResult[index], 10)
    return isNaN(parsed) ? undefined : parsed
  }

  if (result) {
    const hour = getRegexRes(result, 1)
    const min = getRegexRes(result, 2)
    const sec = getRegexRes(result, 3)

    if (hour !== undefined && min !== undefined && sec !== undefined) {
      return [hour, min, sec]
    }
  }

  return [0, 0, 0]
}

export function isExecutable(status: Status): boolean {
  return status === "PENDING" || status === "INCOMPLETE" || status === "OVERDUE"
}

export function customCompare(
  a: number | undefined,
  b: number | undefined,
): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b
}

export function getFirstActiveSubStepInfo(
  stepPropsArray: StepGeneratorData[],
  stepDict: Record<string, Step>,
): Step | undefined {
  const activeStep = stepPropsArray.find(
    (stepProps) =>
      stepProps.step.status && isExecutable(stepProps.step.status as Status),
  )?.step

  if (!activeStep) return undefined

  const childSteps = activeStep.child_step_ids
    ?.map((id) => stepDict[id])
    .filter(Boolean) || [activeStep]

  return childSteps
    .sort((a, b) => customCompare(a.position, b.position))
    .find((step) => step.status && isExecutable(step.status as Status))
}

export function addTime(tB: string, tA: string): string {
  const matchA = parseTime(tA)
  const matchB = parseTime(tB)

  const hrSum = matchA[0] + matchB[0]
  const minSum = matchA[1] + matchB[1]
  const secSum = matchA[2] + matchB[2]

  let carry = 0
  const totalSec = secSum % 60
  carry = Math.floor(secSum / 60)

  const totalMin = (minSum + carry) % 60
  carry = Math.floor((minSum + carry) / 60)

  const totalHr = hrSum + carry

  return (
    padWithZero(totalHr) +
    ":" +
    padWithZero(totalMin) +
    ":" +
    padWithZero(totalSec)
  )
}

export function fillConnectedChildSteps(
  childStepIds: string[],
  connectedStepList: string[],
  stepDict: Record<string, Step>,
  visited: Set<string> = new Set(),
): void {
  for (const childStepId of childStepIds) {
    if (visited.has(childStepId)) continue
    visited.add(childStepId)
    connectedStepList.push(childStepId)
    const childStep = stepDict[childStepId]
    if (childStep?.child_step_ids?.length) {
      fillConnectedChildSteps(
        childStep.child_step_ids,
        connectedStepList,
        stepDict,
        visited,
      )
    }
  }
}

export function flowBFS(
  stepDict: Record<string, Step>,
  flow: Flow | LegacyFlow,
): [ComponentListData[], number, number, string] {
  const legacyFlow = flow as LegacyFlow
  const rootStep = stepDict[legacyFlow.root_step_id] || defaultStep
  const traversedArray = [rootStep.id]
  const componentList: ComponentListData[] = []
  const connectedStepList = [rootStep.id]

  let offSet = 0
  let stepNumber = 1
  let doneCount = rootStep.status === "DONE" ? 1 : 0
  let serialSteps: SerialComponents[] = [
    {
      type: "Step",
      data: {
        step: rootStep,
        stepNumber,
        isRootStep: true,
        isLastStep: false,
        isConnectedStep: true,
      },
    },
  ]
  let etaSum = "00:00:00"
  let queue = [rootStep]

  while (queue.length > 0) {
    const newBlockingStepsArray: Step[] = []

    queue.forEach((step) => {
      if (step.time_needed) {
        etaSum = addTime(etaSum, step.time_needed)
      }
      if (step.child_step_ids) {
        fillConnectedChildSteps(
          step.child_step_ids,
          connectedStepList,
          stepDict,
        )
        step.child_step_ids.forEach((id) => {
          const childStep = stepDict[id]
          if (childStep?.time_needed) {
            etaSum = addTime(etaSum, childStep.time_needed)
          }
        })
      }

      const isParallelBlockingLevel = (step.blocking_step_ids || []).length > 1

      if (isParallelBlockingLevel) {
        componentList.push({
          level: componentList.length,
          marginLeft: offSet,
          serialComponents: [...serialSteps],
          className: "flex",
        })
        offSet += Math.floor(serialSteps.length / 2 + 1) * 520
        serialSteps = []
      }

      const blockingSteps = step.blocking_step_ids || []
      blockingSteps.forEach((blockingStepId) => {
        const blockingStep = stepDict[blockingStepId] || defaultStep

        if (!traversedArray.includes(blockingStepId)) {
          stepNumber++
          traversedArray.push(blockingStepId)
          doneCount += blockingStep.status === "DONE" ? 1 : 0

          serialSteps.push({
            type: "Step",
            data: {
              step: blockingStep,
              stepNumber,
              isRootStep: false,
              isLastStep: blockingStepId === legacyFlow.last_step_id,
              isConnectedStep: true,
            },
          })

          connectedStepList.push(blockingStep.id)
          newBlockingStepsArray.push(blockingStep)
        }
      })

      if (isParallelBlockingLevel) {
        componentList.push({
          level: componentList.length,
          marginLeft: offSet - 180,
          serialComponents: [...serialSteps],
          className: "flex flex-col justify-center",
        })
        offSet += 520 - 180
        serialSteps = []
        return
      }
    })

    queue = newBlockingStepsArray
  }

  componentList.push({
    level: componentList.length,
    marginLeft: offSet,
    serialComponents: [...serialSteps],
    className: "flex flex-row gap-[146px]",
  })

  return [componentList, stepNumber, doneCount, etaSum]
}
