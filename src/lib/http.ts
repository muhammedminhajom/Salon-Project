import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}

export function appOrigin(request: Request) {
  return new URL(process.env.APP_URL ?? request.url).origin;
}

export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== appOrigin(request)) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "This request must come from Bloom & Blush.", "INVALID_ORIGIN");
  }
}

export async function json<T>(request: Request, schema: ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send an application/json request.");
  }
  const input = await bodyBytes(request, 64_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON request.");
  }
  return schema.parse(parsed);
}

export async function bodyBytes(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "This upload or request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function respond(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function route<T extends unknown[]>(handler: (request: Request, ...args: T) => Promise<Response>) {
  return async (request: Request, ...args: T) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) assertOrigin(request);
      return await handler(request, ...args);
    } catch (error) {
      if (error instanceof HttpError)
        return respond({ error: error.message, code: error.code }, error.status);
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        const field = issue?.path.join(".");
        return respond(
          { error: field ? `${field}: ${issue.message}` : issue?.message, code: "INVALID_INPUT" },
          400,
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return respond(
          { error: "An account or record with those details already exists.", code: "ALREADY_EXISTS" },
          409,
        );
      }
      console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
      return respond({ error: "Something went wrong. Please try again.", code: "SERVER_ERROR" }, 500);
    }
  };
}

export function safeNext(value: string | null | undefined, fallback = "/") {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 0x20)
  ) {
    return fallback;
  }
  return value;
}
