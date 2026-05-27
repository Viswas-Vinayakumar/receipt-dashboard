// Platform-aware backend URL + fetch helper.
//
// Desktop (Tauri): backend runs locally on the same Mac → default http://localhost:8888.
// Android (Capacitor): backend runs on the user's Mac → user must set their Mac's LAN IP
//                      in the in-app Settings (e.g. http://192.168.1.42:8888).
//
// We use native fetch() everywhere. Tauri v2 allows it via its http allowlist, and Capacitor's
// WebView allows cleartext HTTP to LAN IPs once we declare it in AndroidManifest.

const STORAGE_KEY = 'rezet.backendUrl'

export const isMobile = (() => {
  // Capacitor sets window.Capacitor when running in the native shell
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.()
})()

export const isTauri = (() => {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
})()

export function getBackendUrl(): string {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (stored && stored.trim()) return stored.replace(/\/+$/, '')
  // Desktop default — Tauri talks to its own sidecar on localhost
  return 'http://localhost:8888'
}

export function setBackendUrl(url: string) {
  const clean = url.trim().replace(/\/+$/, '')
  if (clean) localStorage.setItem(STORAGE_KEY, clean)
  else localStorage.removeItem(STORAGE_KEY)
}

/** Fetch wrapper that prepends the configured backend URL to a path like "/api/dashboard". */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = getBackendUrl()
  const url = path.startsWith('http') ? path : `${base}${path}`
  return fetch(url, init)
}

/** Best-effort detection: are we likely on the same machine as the backend? */
export function isLocalBackend(): boolean {
  const url = getBackendUrl()
  return /127\.0\.0\.1|localhost/.test(url)
}
