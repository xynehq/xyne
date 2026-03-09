import React, { useMemo } from "react"
import { Loader2 } from "lucide-react"
import {
  useReasoningContext,
  AgentBlock,
  ToolBlock,
  ReasoningStepComponent,
  PlanCard,
  WINDOW_SIZE,
  type FlatItem,
} from "./ReasoningContext"

/**
 * Streaming view: renders multiple boxes while the agent is running.
 *
 * Layout:
 *  • One "main orchestrator" box — shows the last WINDOW_SIZE non-delegation steps
 *    with a top fade gradient when items are hidden above the window.
 *  • One box per agent delegation — each delegation (kind="agent" FlatItem) gets
 *    its own bordered card below the main box.
 *
 * Both boxes use a sliding window so the user always sees the latest activity
 * without the layout jumping around.
 */
const StreamingReasoning: React.FC = () => {
  const {
    flatItems,
    agentPlans,
    isStreaming,
    citations,
    citationMap,
    getAppIcon,
    orchestratorPlan,
  } = useReasoningContext()

  // Non-agent items belong to the main orchestrator box
  type NonAgentItem = FlatItem & { kind: "step" | "tool" }
  const mainItems = useMemo(
    () => flatItems.filter((item): item is NonAgentItem => item.kind !== "agent"),
    [flatItems],
  )

  // Each agent delegation gets its own box
  type AgentItem = FlatItem & { kind: "agent" }
  const agentItems = useMemo(
    () => flatItems.filter((item): item is AgentItem => item.kind === "agent"),
    [flatItems],
  )

  // Sliding window — always show the latest WINDOW_SIZE orchestrator items
  const visibleMainItems =
    mainItems.length > WINDOW_SIZE ? mainItems.slice(-WINDOW_SIZE) : mainItems

  // Show the main box if there are orchestrator steps, OR if streaming has started
  // but no agent boxes or plan card exist yet (need something to show life).
  const showMainBox =
    mainItems.length > 0 ||
    (isStreaming && agentItems.length === 0 && !orchestratorPlan)

  return (
    <div className="p-4 space-y-3">
      <style>{`
        @keyframes rsStepIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .reasoning-step-enter {
          animation: rsStepIn 0.18s ease-out forwards;
        }
      `}</style>

      {/* Orchestrator plan card — pinned above all boxes */}
      {orchestratorPlan && (
        <PlanCard plan={orchestratorPlan} isStreaming={isStreaming} />
      )}

      {/* ── Main orchestrator box ── */}
      {showMainBox && (
        <div className="relative rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-slate-700 px-4 py-3">
          {/* Top fade when earlier items are hidden by the sliding window */}
          {mainItems.length > WINDOW_SIZE && (
            <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-white dark:from-slate-700 to-transparent z-10 pointer-events-none rounded-t-xl" />
          )}

          {mainItems.length === 0 ? (
            <div className="flex items-center py-2 text-gray-500 dark:text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2 flex-shrink-0" />
              <span className="text-sm">initializing...</span>
            </div>
          ) : (
            <div className="space-y-1">
              {visibleMainItems.map((item) => (
                <div key={item.key} className="reasoning-step-enter">
                  {item.kind === "tool" ? (
                    <ToolBlock
                      toolName={item.toolName}
                      steps={item.steps}
                      isStreaming={isStreaming}
                      citations={citations}
                      citationMap={citationMap}
                      getAppIcon={getAppIcon}
                    />
                  ) : (
                    <ReasoningStepComponent
                      step={item.step}
                      index={0}
                      isStreaming={isStreaming}
                      isLastStep={false}
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
      )}

      {/* ── One box per agent delegation ── */}
      {agentItems.map((item) => (
        <div
          key={item.key}
          className="relative rounded-xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/30 dark:bg-blue-950/20 px-4 py-3"
        >
          {/* AgentBlock in "box" variant removes the left-border indent */}
          <AgentBlock
            agentName={item.agentName}
            steps={item.steps}
            plan={agentPlans[item.planKey]}
            isStreaming={isStreaming}
            citations={citations}
            citationMap={citationMap}
            getAppIcon={getAppIcon}
            variant="box"
          />
        </div>
      ))}
    </div>
  )
}

export default StreamingReasoning
