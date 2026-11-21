import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { isLoopbackHost } from "@/lib/local-demo";
import { digest, hashPassword, token } from "@/lib/secrets";

const expiryMinutes = 30;
const invalidReset = () =>
  new HttpError(400, "This reset link is invalid or has expired. Request a new link.", "INVALID_RESET_TOKEN");

export function passwordResetConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.PASSWORD_RESET_FROM?.trim();
  if (!apiKey || !from) return null;
  try {
    const base = new URL(process.env.APP_URL ?? "");
    if (
      !base.username &&
      !base.password &&
      (base.protocol === "https:" || (base.protocol === "http:" && isLoopbackHost(base.hostname)))
    ) {
      return { apiKey, from, origin: base.origin };
    }
  } catch {
    // Password reset links require a configured canonical origin.
  }
  return null;
}

export async function deliverPasswordReset(
  config: NonNullable<ReturnType<typeof passwordResetConfig>>,
  recipient: string,
  resetToken: string,
) {
  const url = new URL("/account/reset-password", config.origin);
  url.hash = new URLSearchParams({ token: resetToken }).toString();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.from,
      to: [recipient],
      subject: "Reset your Bloom & Blush password",
      text: `Reset your password with this link, which expires in ${expiryMinutes} minutes.\n\n${url.href}\n\nIf you did not request this, you can ignore this email.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Password reset email delivery failed.");
}

export async function issuePasswordReset(
  email: string,
  deliver: (recipient: string, resetToken: string) => Promise<void>,
) {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true, role: true, staff: { select: { active: true } } },
  });
  if (!user?.email || !user.passwordHash || (user.role === "STAFF" && !user.staff?.active)) return;
  const resetToken = token();
  const now = new Date();
  const issued = await db.$transaction(async (tx) => {
    const [current] = await tx.$queryRaw<
      { passwordHash: string | null }[]
    >`SELECT "passwordHash" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    if (!current || current.passwordHash !== user.passwordHash) return false;
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, expiresAt: { lte: now } } });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: digest(resetToken),
        expiresAt: new Date(+now + expiryMinutes * 60_000),
      },
    });
    return true;
  });
  if (issued) await deliver(user.email, resetToken);
}

export async function completePasswordReset(resetToken: string, password: string) {
  const tokenHash = digest(resetToken);
  const pending = await db.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!pending || pending.usedAt || pending.expiresAt <= new Date()) throw invalidReset();
  const passwordHash = await hashPassword(password);

  await db.$transaction(async (tx) => {
    const [user] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "User" WHERE "id" = ${pending.userId} FOR UPDATE`;
    if (!user) throw invalidReset();
    const now = new Date();
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (!claimed.count) throw invalidReset();
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
}
