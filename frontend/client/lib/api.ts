// lib/api.ts
const BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5555").replace(/\/$/, "")

export async function apiFetch(path: string, options: RequestInit = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const url = `${BASE_URL}${normalizedPath}`

  console.log("[apiFetch]", options.method || "GET", url)

  const headers = new Headers(options.headers || {})

  // Only set Content-Type when sending a body (avoids weird preflights sometimes)
  const hasBody = options.body !== undefined && options.body !== null
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(url, {
    ...options,
    headers,
    // ✅ IMPORTANT: send/receive cookies always
    credentials: options.credentials ?? "include",
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = `Request failed: ${res.status} ${res.statusText}`

    try {
      const j = text ? JSON.parse(text) : null
      message = (j as any)?.error || (j as any)?.message || message
    } catch {
      if (text) message = text
    }

    throw new Error(message)
  }

  return res
}
console.log("BASE_URL =", BASE_URL);