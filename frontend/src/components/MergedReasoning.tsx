import React from "react"
import {
  useReasoningContext,
  AgentBlock,
  ToolBlock,
  ReasoningStepComponent,
  PlanCard,
} from "./ReasoningContext"

/**
 * Merged (post-stream) view: one big scrollable box containing every reasoning
 * step in chronological order.
 *
 * Agent delegations appear inline with a collapsible "Consulting X" header.
 * Tool blocks are collapsed by default (they opened during streaming and are
 * now collapsed via the ToolBlock's isStreaming=false useEffect).
 */
const MergedReasoning: React.FC = () => {
  const {
    flatItems,
    agentPlans,
    citations,
    citationMap,
    getAppIcon,
    orchestratorPlan,
  } = useReasoningContext()

  return (
    <div className="px-6 pb-6 pt-2">
      <div
        className="max-h-80 overflow-y-auto pr-1"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {/* Orchestrator plan — pinned at the top of the merged list */}
        {orchestratorPlan && (
          <div className="mb-3">
            <PlanCard plan={orchestratorPlan} isStreaming={false} />
          </div>
        )}

        {flatItems.length === 0 ? (
          <div className="py-4 text-gray-500 dark:text-gray-400 text-sm">
            No reasoning steps available
          </div>
        ) : (
          <div className="space-y-1 w-full max-w-full">
            {flatItems.map((item, index) => (
              <div key={item.key}>
                {item.kind === "agent" ? (
                  // Inline variant keeps the left-border indent style
                  <AgentBlock
                    agentName={item.agentName}
                    steps={item.steps}
                    plan={agentPlans[item.planKey]}
                    isStreaming={false}
                    citations={citations}
                    citationMap={citationMap}
                    getAppIcon={getAppIcon}
                    variant="inline"
                  />
                ) : item.kind === "tool" ? (
                  <ToolBlock
                    toolName={item.toolName}
                    steps={item.steps}
                    isStreaming={false}
                    citations={citations}
                    citationMap={citationMap}
                    getAppIcon={getAppIcon}
                  />
                ) : (
                  <ReasoningStepComponent
                    step={item.step}
                    index={index}
                    isStreaming={false}
                    isLastStep={index === flatItems.length - 1}
                    depth={0}
                    citations={citations}
                    citationMap={citationMap}
                    getAppIcon={getAppIcon}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default MergedReasoning
