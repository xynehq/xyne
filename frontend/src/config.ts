import { authFetch } from "./utils/authFetch"

let configPromise: Promise<{
  API_BASE_URL: string
  WS_BASE_URL: string
}> | null = null
export function loadConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const res = await authFetch("/config")
        if (!res.ok) {
          throw new Error(`Failed to fetch config: ${res.statusText}`)
        }
        return await res.json()
      } catch (e) {
        configPromise = null // Allow retries on failure
        throw e
      }
    })()
  }
  return configPromise
}
