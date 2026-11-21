import { after } from "next/server";
import { db } from "@/lib/db";
import { beginGoogle, checkOtp, finishGoogle, sendOtp } from "@/lib/auth-endpoints";
import {
  accountAllowed,
  createAccount,
  endSession,
  getViewer,
  limit,
  limitAddress,
  refreshSession,
  roleHome,
  startSession,
  viewerSelect,
} from "@/lib/auth";
import { HttpError, json, respond, route } from "@/lib/http";
import {
  completePasswordReset,
  deliverPasswordReset,
  issuePasswordReset,
  passwordResetConfig,
} from "@/lib/password-reset";
import {
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  signInSchema,
  signUpSchema,
} from "@/lib/schemas";
import { checkPassword, hashPassword } from "@/lib/secrets";

type Context = { params: Promise<{ action: string }> };

export const GET = route(async (request, { params }: Context) => {
  const { action } = await params;
  if (action === "me") return respond({ user: await getViewer() });
  if (action === "google") return beginGoogle(request);
  if (action === "google-callback") return finishGoogle(request);
  throw new HttpError(404, "Authentication action not found.");
});

export const POST = route(async (request, { params }: Context) => {
  const { action } = await params;
  if (action === "refresh") return respond({ user: await refreshSession() });
  if (action === "logout") {
    await endSession();
    return respond({ ok: true });
  }
  if (action === "otp-send") return sendOtp(request);
  if (action === "otp-check") return checkOtp(request);
  if (action === "password-reset-request") {
    const { email } = await json(request, passwordResetRequestSchema);
    const config = passwordResetConfig();
    if (!config) throw new HttpError(503, "Password reset email is unavailable.", "RESET_EMAIL_UNAVAILABLE");
    await limitAddress(request, "password-reset-request-ip", 20, 900);
    await limit("password-reset-email", email, 3, 900);
    after(async () => {
      if (!accountAllowed(email)) return;
      try {
        await issuePasswordReset(email, (recipient, resetToken) =>
          deliverPasswordReset(config, recipient, resetToken),
        );
      } catch {
        console.error("Could not send a password reset email.");
      }
    });
    return respond({ ok: true }, 202);
  }
  if (action === "password-reset-complete") {
    const { token, password } = await json(request, passwordResetCompleteSchema);
    await limitAddress(request, "password-reset-complete-ip", 30, 900);
    await limit("password-reset-token", token, 8, 900);
    await completePasswordReset(token, password);
    return respond({ ok: true });
  }
  if (action === "register") {
    const { password, referralCode, ...data } = await json(request, signUpSchema);
    await limitAddress(request, "register-ip", 20, 3600);
    await limit("register-email", data.email, 4, 900);
    const passwordHash = await hashPassword(password);
    const user = await db.$transaction(async (tx) => {
      const referredByCode = referralCode
        ? await tx.referralCode.findUnique({ where: { code: referralCode }, select: { id: true } })
        : null;
      if (referralCode && !referredByCode) throw new HttpError(400, "That referral code is not valid.");
      return createAccount({ ...data, passwordHash, referredByCodeId: referredByCode?.id }, tx);
    });
    await startSession(user.id, passwordHash);
    return respond({ user, destination: roleHome(user.role) }, 201);
  }
  if (action === "login") {
    const data = await json(request, signInSchema);
    await limitAddress(request, "login-ip", 60, 900);
    await limit("login-email", data.email, 12, 900);
    const account = await db.user.findUnique({
      where: { email: data.email },
      select: { ...viewerSelect, passwordHash: true, staff: { select: { active: true } } },
    });
    if (
      !(await checkPassword(data.password, account?.passwordHash)) ||
      !account?.passwordHash ||
      !accountAllowed(account.email) ||
      (account.role === "STAFF" && !account.staff?.active)
    ) {
      throw new HttpError(401, "The email or password is incorrect.", "INVALID_CREDENTIALS");
    }
    const { id, name, email, phone, role, passwordHash } = account;
    const user = { id, name, email, phone, role };
    await startSession(id, passwordHash);
    return respond({ user, destination: roleHome(user.role) });
  }
  throw new HttpError(404, "Authentication action not found.");
});
