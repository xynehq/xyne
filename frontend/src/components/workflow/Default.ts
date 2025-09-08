import { Step } from "./Types"

export const defaultStep: Step = {
  id: "default",
  name: "Default Step",
  type: "manual",
  status: "pending",
  description: "Default step for workflow",
  parentStepId: null,
  nextStepIds: null,
  toolIds: null,
  timeEstimate: 0,
  metadata: null,
  contents: [],
}
