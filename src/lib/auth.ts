import { Prisma, type ProviderType, type Role } from "@prisma/client";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { HttpError, safeNext } from "@/lib/http";
import { demoEmail, localDemoAllowed } from "@/lib/local-demo";
import { digest, secret, token } from "@/lib/secrets";

const ACCESS_SECONDS = 15 * 60;
const SESSION_DAYS = 30;
const secure = () =>
  process.env.COOKIE_SECURE === "true" ||
  (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false");
export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: secure(),
  path: "/",
});
export const viewerSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
} satisfies Prisma.UserSelect;
export type Viewer = Prisma.UserGetPayload<{ select: typeof viewerSelect }>;
export const jwtKey = () => new TextEncoder().encode(secret("AUTH_SECRET"));

export function accountAllowed(email?: string | null) {
  return !demoEmail(email) || localDemoAllowed();
}

export function roleHome(role: Role) {
  if (role === "ADMIN") return "/admin";
  if (role === "PROVIDER" || role === "STAFF") return "/studio";
  return "/appointments";
}

export async function createAccount(
  input: {
    name: string;
    email?: string;
    passwordHash?: string;
    phone?: string;
    googleSub?: string;
    type?: ProviderType;
    referredByCodeId?: string;
  },
  client: Prisma.TransactionClient = db,
) {
  if (!accountAllowed(input.email)) throw new HttpError(400, "Use a different email address.");
  const { type, ...account } = input;
  const slug =
    input.name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42)
      .replace(/-$/, "") || "studio";
  const user = await client.user.create({
    data: {
      ...account,
      role: type ? "PROVIDER" : "CUSTOMER",
      ...(type
        ? {
            provider: {
              create: { displayName: input.name, slug: `${slug}-${digest(token()).slice(0, 8)}`, type },
            },
          }
        : { customer: { create: {} } }),
    },
    select: viewerSelect,
  });
  if (!type) {
    await client.referralCode.create({
      data: { userId: user.id, code: digest(token()).slice(0, 10).toUpperCase() },
    });
  }
  return user;
}

async function writeSessionCookies(userId: string, sessionId: string, refresh: string, expiresAt: Date) {
  const access = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("bloom-and-blush")
    .setAudience("web-session")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_SECONDS}s`)
    .sign(jwtKey());
  const jar = await cookies();
  jar.set("bb-access", access, { ...cookieOptions(), maxAge: ACCESS_SECONDS });
  jar.set("bb-refresh", `${sessionId}.${refresh}`, { ...cookieOptions(), expires: expiresAt });
}

export async function startSession(userId: string, authenticatedPasswordHash?: string) {
  const id = token(18);
  const refresh = token();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const data = { id, userId, expiresAt, tokenHash: digest(refresh) };
  if (authenticatedPasswordHash) {
    await db.$transaction(async (tx) => {
      // Password recovery and password sign-in serialize on the same account row.
      const [user] = await tx.$queryRaw<
        { passwordHash: string | null }[]
      >`SELECT "passwordHash" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (user?.passwordHash !== authenticatedPasswordHash) {
        throw new HttpError(401, "The email or password is incorrect.", "INVALID_CREDENTIALS");
      }
      await tx.session.create({ data });
    });
  } else {
    await db.session.create({ data });
  }
  await writeSessionCookies(userId, id, refresh, expiresAt);
}

export async function refreshSession() {
  const [id, refresh] = ((await cookies()).get("bb-refresh")?.value ?? "").split(".");
  if (!id || !refresh) throw new HttpError(401, "Sign in to continue.", "SIGN_IN");
  const current = await db.session.findUnique({ where: { id }, include: { user: { select: viewerSelect } } });
  const currentHash = digest(refresh);
  if (
    !current ||
    current.revokedAt ||
    current.expiresAt <= new Date() ||
    current.tokenHash !== currentHash ||
    !accountAllowed(current.user.email)
  ) {
    throw new HttpError(401, "Sign in to continue.", "SIGN_IN");
  }
  const next = token();
  const updated = await db.session.updateMany({
    where: { id, tokenHash: currentHash, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { tokenHash: digest(next) },
  });
  if (!updated.count) throw new HttpError(409, "This session was refreshed in another request.", "REFRESHED");
  await writeSessionCookies(current.user.id, id, next, current.expiresAt);
  return current.user;
}

async function accessSession(value?: string) {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, jwtKey(), {
      algorithms: ["HS256"],
      issuer: "bloom-and-blush",
      audience: "web-session",
    });
    return payload.sub && typeof payload.sid === "string" ? { userId: payload.sub, id: payload.sid } : null;
  } catch {
    return null;
  }
}

export async function revokeSession(access?: string, refreshCookie?: string) {
  const proof = await accessSession(access);
  const [id, refresh] = (refreshCookie ?? "").split(".");
  const identity = proof ?? (id && refresh ? { id, tokenHash: digest(refresh) } : null);
  if (identity)
    await db.session.updateMany({ where: { ...identity, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function endSession() {
  const jar = await cookies();
  await revokeSession(jar.get("bb-access")?.value, jar.get("bb-refresh")?.value);
  jar.set("bb-access", "", { ...cookieOptions(), maxAge: 0 });
  jar.set("bb-refresh", "", { ...cookieOptions(), maxAge: 0 });
}

export async function getViewer() {
  const proof = await accessSession((await cookies()).get("bb-access")?.value);
  if (!proof) return null;
  const session = await db.session.findUnique({
    where: { id: proof.id },
    include: { user: { select: viewerSelect } },
  });
  return session &&
    session.userId === proof.userId &&
    session.expiresAt > new Date() &&
    !session.revokedAt &&
    accountAllowed(session.user.email)
    ? session.user
    : null;
}

export async function requireUser(...roles: Role[]) {
  const user = await getViewer();
  if (!user) throw new HttpError(401, "Sign in to continue.", "SIGN_IN");
  if (roles.length && !roles.includes(user.role))
    throw new HttpError(403, "Your account does not have access to this action.", "FORBIDDEN");
  return user;
}

export async function pageUser(next: string, ...roles: Role[]) {
  const user = await getViewer();
  if (!user) {
    const target = (await cookies()).has("bb-refresh") ? "/session" : "/account";
    redirect(`${target}?next=${encodeURIComponent(safeNext(next))}`);
  }
  if (roles.length && !roles.includes(user.role)) redirect(roleHome(user.role));
  return user;
}

export async function limit(scope: string, key: string, max: number, seconds: number) {
  const result = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "count", "expiresAt")
    VALUES (${digest(`${scope}:${key}`)}, 1, NOW() + ${seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."expiresAt" <= NOW() THEN 1 ELSE LEAST("RateLimit"."count" + 1, ${max + 1}) END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= NOW() THEN EXCLUDED."expiresAt" ELSE "RateLimit"."expiresAt" END
    RETURNING "count"
  `;
  if (result[0].count > max)
    throw new HttpError(429, "Too many attempts. Try again in a few minutes.", "RATE_LIMITED");
}

export async function limitAddress(request: Request, scope: string, max: number, seconds: number) {
  const header = process.env.TRUSTED_CLIENT_IP_HEADER;
  const address = header && request.headers.get(header)?.split(",")[0]?.trim();
  if (address) await limit(scope, address, max, seconds);
}
