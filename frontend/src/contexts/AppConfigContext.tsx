import { authFetch } from "@/utils/authFetch"
import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
} from "react"

export interface AppConfig {
  agenticByDefault: boolean
  isDemo: boolean
}

const defaults: AppConfig = {
  agenticByDefault: false,
  isDemo: false,
}

const AppConfigContext = createContext<AppConfig>(defaults)

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(defaults)

  useEffect(() => {
    authFetch("/api/v1/config", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("config failed"))))
      .then((data: AppConfig) =>
        setConfig({
          agenticByDefault: data.agenticByDefault === true,
          isDemo: data.isDemo === true,
        }),
      )
      .catch(() => {
        // Keep defaults on error (e.g. dev without backend)
      })
  }, [])

  return (
    <AppConfigContext.Provider value={config}>
      {children}
    </AppConfigContext.Provider>
  )
}

export function useAppConfig(): AppConfig {
  const ctx = useContext(AppConfigContext)
  return ctx ?? defaults
}
