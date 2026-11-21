import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  cookieOptions,
  createAccount,
  jwtKey,
  limit,
  limitAddress,
  roleHome,
  startSession,
  viewerSelect,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { appOrigin, HttpError, json, respond, safeNext } from "@/lib/http";
import { localDemoAllowed } from "@/lib/local-demo";
import { otpCheckSchema, otpSendSchema, providerType } from "@/lib/schemas";
import { token } from "@/lib/secrets";

const devOtp = () =>
  localDemoAllowed() && /^\d{4,8}$/.test(process.env.OTP_DEV_CODE ?? "") && process.env.OTP_DEV_CODE;
export const googleReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const smsReady = () =>
  Boolean(
    devOtp() ||
    (process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_VERIFY_SERVICE_SID),
  );

async function verifyApi(path: string, parameters: Record<string, string>) {
  const {
    TWILIO_ACCOUNT_SID: sid,
    TWILIO_AUTH_TOKEN: secret,
    TWILIO_VERIFY_SERVICE_SID: service,
  } = process.env;
  if (!sid || !secret || !service) throw new HttpError(503, "SMS sign-in is unavailable.");
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => {
    throw new HttpError(502, "The SMS service is unavailable. Please try again.");
  });
  if (!response.ok) {
    if (path === "VerificationCheck" && [400, 404].includes(response.status)) return { status: "invalid" };
    if (response.status === 429) throw new HttpError(429, "Too many attempts. Please try again later.");
    throw new HttpError(502, "The SMS service is unavailable. Please try again.");
  }
  return (await response.json()) as { status: string };
}

export async function sendOtp(request: Request) {
  if (!smsReady()) throw new HttpError(503, "SMS sign-in is unavailable.");
  const input = await json(request, otpSendSchema);
  await limitAddress(request, "otp-ip", 10, 3600);
  await limit("otp-cooldown", input.phone, 1, 45);
  await limit("otp-send", input.phone, 4, 900);
  if (!devOtp()) await verifyApi("Verifications", { To: input.phone, Channel: "sms" });
  const challenge = await db.otpChallenge.create({
    data: { ...input, id: token(24), expiresAt: new Date(Date.now() + 300_000) },
  });
  return respond({ challenge: challenge.id, expiresIn: 300 });
}

export async function checkOtp(request: Request) {
  if (!smsReady()) throw new HttpError(503, "SMS sign-in is unavailable.");
  const input = await json(request, otpCheckSchema);
  await limitAddress(request, "otp-check-ip", 30, 3600);
  const challenge = await db.otpChallenge.findUnique({ where: { id: input.challenge } });
  const invalid = new HttpError(400, "That code is invalid or has expired.", "INVALID_CODE");
  if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date()) throw invalid;
  await limit("otp-check", challenge.id, 5, 300);
  const localCode = devOtp();
  const verified = localCode
    ? input.code === localCode
    : (await verifyApi("VerificationCheck", { To: challenge.phone, Code: input.code })).status === "approved";
  if (!verified) throw invalid;
  const user = await db.$transaction(async (tx) => {
    const updated = await tx.otpChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!updated.count) throw invalid;
    return (
      (await tx.user.findUnique({ where: { phone: challenge.phone }, select: viewerSelect })) ??
      (await createAccount(
        { phone: challenge.phone, name: challenge.name ?? "New member", type: challenge.type ?? undefined },
        tx,
      ))
    );
  });
  await startSession(user.id);
  return respond({ user, destination: roleHome(user.role) });
}

function googleClient(request: Request) {
  if (!googleReady()) throw new HttpError(503, "Google sign-in is unavailable.");
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${appOrigin(request)}/api/auth/google-callback`,
  );
}

export async function beginGoogle(request: Request) {
  if (!googleReady()) throw new HttpError(503, "Google sign-in is unavailable.");
  const { searchParams } = new URL(request.url);
  const state = token();
  const nonce = token();
  const verifier = token(48);
  const next = safeNext(searchParams.get("next"), "");
  const type = providerType.safeParse(searchParams.get("type")).data;
  const ticket = await new SignJWT({ state, nonce, verifier, next, type })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("bloom-and-blush")
    .setAudience("google-oauth")
    .setExpirationTime("10m")
    .sign(jwtKey());
  (await cookies()).set("bb-google", ticket, { ...cookieOptions(), maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${appOrigin(request)}/api/auth/google-callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return Response.redirect(url);
}

const googleClaims = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  next: z.string(),
  type: providerType.optional(),
});

export async function finishGoogle(request: Request) {
  const origin = appOrigin(request);
  const failure = (code: string) => Response.redirect(new URL(`/account?error=${code}`, origin));
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const jar = await cookies();
  const ticket = jar.get("bb-google")?.value;
  jar.set("bb-google", "", { ...cookieOptions(), maxAge: 0 });
  if (!ticket || !code) return failure("google");
  try {
    const signed = await jwtVerify(ticket, jwtKey(), {
      algorithms: ["HS256"],
      issuer: "bloom-and-blush",
      audience: "google-oauth",
    });
    const claims = googleClaims.parse(signed.payload);
    if (claims.state !== query.get("state")) return failure("google");
    const client = googleClient(request);
    const { tokens } = await client.getToken({ code, codeVerifier: claims.verifier });
    if (!tokens.id_token) return failure("google");
    const payload = (
      await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID })
    ).getPayload();
    if (!payload?.sub || !payload.email_verified || !payload.email || payload.nonce !== claims.nonce)
      return failure("google");
    const email = payload.email.toLowerCase();
    let user = await db.user.findUnique({ where: { googleSub: payload.sub }, select: viewerSelect });
    if (!user) {
      if (await db.user.findUnique({ where: { email }, select: { id: true } }))
        return failure("account-exists");
      user = await createAccount({
        email,
        googleSub: payload.sub,
        name: payload.name?.slice(0, 80) || "New member",
        type: claims.type,
      });
    }
    await startSession(user.id);
    return Response.redirect(new URL(safeNext(claims.next, roleHome(user.role)), origin));
  } catch {
    return failure("google");
  }
}
