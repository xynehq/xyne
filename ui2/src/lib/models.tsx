import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { getModels, type ModelInfo } from "./api"

const STORAGE_KEY = "ui2.selectedModel"

type ModelsContextValue = {
  models: ModelInfo[]
  loading: boolean
  selected: string | null
  setSelected: (label: string) => void
  groups: Array<{ family: ModelFamily; items: ModelInfo[] }>
}

export type ModelFamily = "Claude" | "GPT" | "Gemini" | "Other"

const detectFamily = (labelName: string): ModelFamily => {
  if (/claude|sonnet|opus|haiku/i.test(labelName)) {
    return "Claude"
  }
  if (/gpt|openai|o[1-5]\b/i.test(labelName)) {
    return "GPT"
  }
  if (/gemini/i.test(labelName)) {
    return "Gemini"
  }
  return "Other"
}

const familyOrder: ModelFamily[] = ["Claude", "GPT", "Gemini", "Other"]

const groupByFamily = (
  models: ModelInfo[],
): Array<{ family: ModelFamily; items: ModelInfo[] }> => {
  const bucket: Record<ModelFamily, ModelInfo[]> = {
    Claude: [],
    GPT: [],
    Gemini: [],
    Other: [],
  }
  for (const m of models) {
    bucket[detectFamily(m.labelName)].push(m)
  }
  return familyOrder
    .map((family) => ({ family, items: bucket[family] }))
    .filter((g) => g.items.length > 0)
}

const pickDefault = (models: ModelInfo[]): string | null => {
  if (models.length === 0) {
    return null
  }
  const preferred = models.find((m) =>
    /Claude Sonnet 4\.6|Claude Sonnet 4\.5/i.test(m.labelName),
  )
  return (preferred ?? models[0])?.labelName ?? null
}

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const ModelsContext = createContext<ModelsContextValue | null>(null)

export function ModelsProvider({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [selected, setSelectedState] = useState<string | null>(() => readStored())

  useEffect((): (() => void) => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const { models: list } = await getModels()
        if (cancelled) {
          return
        }
        setModels(list)
        setSelectedState((prev) => {
          if (prev && list.some((m) => m.labelName === prev)) {
            return prev
          }
          return pickDefault(list)
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("getModels failed", err)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const setSelected = useCallback((label: string) => {
    setSelectedState(label)
    try {
      window.localStorage.setItem(STORAGE_KEY, label)
    } catch {
      // ignore storage failures
    }
  }, [])

  const groups = useMemo(() => groupByFamily(models), [models])

  const value = useMemo<ModelsContextValue>(
    () => ({ models, loading, selected, setSelected, groups }),
    [models, loading, selected, setSelected, groups],
  )

  return (
    <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
  )
}

export function useModels(): ModelsContextValue {
  const ctx = useContext(ModelsContext)
  if (!ctx) {
    throw new Error("useModels must be used inside <ModelsProvider>")
  }
  return ctx
}
