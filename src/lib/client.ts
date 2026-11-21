"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let refreshInFlight: Promise<boolean> | undefined;

export function refreshBrowserSession() {
  refreshInFlight ??= fetch("/api/auth/refresh", { method: "POST" })
    .then(async (response) => {
      if (response.ok) return true;
      if (response.status === 409 || response.status === 401) {
        const current = await fetch("/api/auth/me");
        return current.ok && Boolean((await current.json()).user);
      }
      return false;
    })
    .catch(() => false)
    .finally(() => {
      refreshInFlight = undefined;
    });
  return refreshInFlight;
}

export async function api<T>(path: string, options?: RequestInit, retry = true): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && retry && !path.startsWith("/api/auth/") && (await refreshBrowserSession())) {
    return api<T>(path, options, false);
  }
  if (!response.ok)
    throw new ApiError(body.error ?? "Something went wrong. Please try again.", response.status, body.code);
  return body as T;
}

export function jsonRequest(method: string, data: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}
