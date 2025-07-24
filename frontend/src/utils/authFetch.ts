export async function authFetch(
  input: RequestInfo,
  init?: RequestInit,
  retry = true,
): Promise<Response> {
  let response = await fetch(input, { ...init, credentials: "include" })
  if (response.status === 401 && retry) {
    // Try to refresh token
    const refresh = await fetch("/api/v1/refresh-token", {
      method: "POST",
      credentials: "include",
    })
    if (refresh.ok) {
      // Retry original request
      response = await fetch(input, { ...init, credentials: "include" })
    }
  }
  return response
}
