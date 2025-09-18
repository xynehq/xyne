// frontend/src/config.ts
let config: { API_BASE_URL: string; WS_BASE_URL: string } | null = null;

export async function loadConfig() {
  if (!config) {
    const res = await fetch("/config");
    config = await res.json();
  }
  return config;
}
