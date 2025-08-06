let isRefreshing = false
let refreshPromise: Promise<Response> | null = null

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let response = await fetch(input, { ...init, credentials: "include" })
  if (response.status === 401) {
    if (!isRefreshing) {
      isRefreshing = true
      refreshPromise = fetch("/api/v1/refresh-token", {
        method: "POST",
        credentials: "include",
      }).finally(() => {
        isRefreshing = false
      })
    }
    // Wait for the refresh to finish
    const refreshRes = await refreshPromise
    if (refreshRes && refreshRes.ok) {
      // Retry the original request
      response = await fetch(input, { ...init, credentials: "include" })
    }
  }
  return response
}
