import { limit, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, json, respond, route } from "@/lib/http";
import { lockProvider } from "@/lib/provider-lock";
import { paymentSettingsSchema } from "@/lib/schemas";

const fields = { depositBps: true, gstRegistered: true, gstin: true, gstRateBps: true } as const;

export const GET = route(async () => {
  const user = await requireUser("PROVIDER");
  const settings = await db.providerProfile.findUnique({ where: { ownerId: user.id }, select: fields });
  if (!settings) throw new HttpError(404, "Studio not found.");
  return respond({ settings });
});

export const PUT = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("payment-settings", user.id, 30, 300);
  const input = await json(request, paymentSettingsSchema);
  const studio = await db.providerProfile.findUnique({ where: { ownerId: user.id }, select: { id: true } });
  if (!studio) throw new HttpError(404, "Studio not found.");
  const settings = await db.$transaction(async (tx) => {
    await lockProvider(tx, studio.id);
    const current = await tx.providerProfile.findUniqueOrThrow({ where: { id: studio.id } });
    if (current.status === "PENDING" || current.status === "SUSPENDED")
      throw new HttpError(409, "Studio changes are paused during review or suspension.");
    const fieldsToSave = {
      depositBps: input.depositBps,
      gstRegistered: input.gstRegistered,
      gstRateBps: input.gstRegistered ? input.gstRateBps : 0,
      gstin: input.gstRegistered ? input.gstin : null,
    };
    if (
      fieldsToSave.depositBps !== current.depositBps ||
      fieldsToSave.gstRegistered !== current.gstRegistered ||
      fieldsToSave.gstRateBps !== current.gstRateBps ||
      fieldsToSave.gstin !== current.gstin
    ) {
      await tx.auditLog.create({
        data: { actorId: user.id, targetId: studio.id, action: "STUDIO_PAYMENT_SETTINGS_CHANGED" },
      });
    }
    return tx.providerProfile.update({ where: { id: studio.id }, data: fieldsToSave, select: fields });
  });
  return respond({ settings });
});
