const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string) {
  return loopbackHosts.has(hostname);
}

export function localDemoAllowed() {
  if (process.env.NODE_ENV === "production") return false;
  try {
    return isLoopbackHost(new URL(process.env.APP_URL ?? "").hostname);
  } catch {
    return false;
  }
}

export function demoEmail(email?: string | null) {
  return email?.endsWith("@bloomblush.test") ?? false;
}
