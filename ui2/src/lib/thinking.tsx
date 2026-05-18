// Reasoning effort selector — stores the user's choice in localStorage and
// makes it available to the composer's send path. Maps 1:1 to pi-ai's
// ThinkingLevel.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type ThinkingLevel = "minimal" | "low" | "medium" | "high"

export const THINKING_LEVELS: ReadonlyArray<{
  value: ThinkingLevel
  label: string
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

const STORAGE_KEY = "ui2.thinkingLevel"
const DEFAULT_LEVEL: ThinkingLevel = "medium"

const isLevel = (v: string | null): v is ThinkingLevel =>
  v === "minimal" || v === "low" || v === "medium" || v === "high"

const readStored = (): ThinkingLevel => {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (isLevel(v)) return v
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_LEVEL
}

type ThinkingContextValue = {
  level: ThinkingLevel
  setLevel: (next: ThinkingLevel) => void
}

const ThinkingContext = createContext<ThinkingContextValue | null>(null)

export function ThinkingProvider({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  const [level, setLevelState] = useState<ThinkingLevel>(() => readStored())

  const setLevel = useCallback((next: ThinkingLevel): void => {
    setLevelState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore storage failures
    }
  }, [])

  const value = useMemo<ThinkingContextValue>(
    () => ({ level, setLevel }),
    [level, setLevel],
  )

  return (
    <ThinkingContext.Provider value={value}>{children}</ThinkingContext.Provider>
  )
}

export function useThinking(): ThinkingContextValue {
  const ctx = useContext(ThinkingContext)
  if (!ctx) {
    throw new Error("useThinking must be used inside <ThinkingProvider>")
  }
  return ctx
}
