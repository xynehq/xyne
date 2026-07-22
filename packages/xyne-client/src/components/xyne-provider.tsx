import { type ReactNode, createContext, useMemo, useRef } from "react"
import type { XyneClientConfig } from "../core/types"
import { XyneClient } from "../core/xyne-client"

export const XyneContext = createContext<XyneClient | null>(null)

export interface XyneProviderProps {
  baseUrl: string
  token: string
  onTokenExpired: () => Promise<string>
  children: ReactNode
}

export function XyneProvider({
  baseUrl,
  token,
  onTokenExpired,
  children,
}: XyneProviderProps) {
  const onTokenExpiredRef = useRef(onTokenExpired)
  onTokenExpiredRef.current = onTokenExpired

  // biome-ignore lint/correctness/useExhaustiveDependencies: token is synced via setToken below, not by recreating the client
  const client = useMemo(
    () =>
      new XyneClient({
        baseUrl,
        token,
        onTokenExpired: () => onTokenExpiredRef.current(),
      } satisfies XyneClientConfig),
    [baseUrl],
  )

  // Keep token in sync
  if (client.getToken() !== token) {
    client.setToken(token)
  }

  return <XyneContext.Provider value={client}>{children}</XyneContext.Provider>
}
