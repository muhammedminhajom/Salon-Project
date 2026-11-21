import { limit, requireUser } from "@/lib/auth";
import { createCoupon, listCoupons, updateCoupon } from "@/lib/coupons";
import { db } from "@/lib/db";
import { HttpError, json, respond, route } from "@/lib/http";
import { couponSchema, couponToggleSchema } from "@/lib/schemas";

async function ownedProvider(userId: string) {
  const provider = await db.providerProfile.findUnique({ where: { ownerId: userId }, select: { id: true } });
  if (!provider) throw new HttpError(404, "Provider profile not found.");
  return provider.id;
}

export const GET = route(async () => {
  const user = await requireUser("PROVIDER");
  return respond({ coupons: await listCoupons(await ownedProvider(user.id)) });
});

export const POST = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("provider-coupon-create", user.id, 30, 3600);
  const input = await json(request, couponSchema);
  return respond({ coupon: await createCoupon(user.id, input, await ownedProvider(user.id)) }, 201);
});

export const PATCH = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("provider-coupon-update", user.id, 60, 300);
  const input = await json(request, couponToggleSchema);
  return respond({
    coupon: await updateCoupon(user.id, input.id, input.active, await ownedProvider(user.id)),
  });
});
