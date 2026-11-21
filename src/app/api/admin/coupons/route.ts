import { limit, requireUser } from "@/lib/auth";
import { createCoupon, listCoupons, updateCoupon } from "@/lib/coupons";
import { json, respond, route } from "@/lib/http";
import { couponSchema, couponToggleSchema } from "@/lib/schemas";

export const GET = route(async () => {
  await requireUser("ADMIN");
  return respond({ coupons: await listCoupons() });
});

export const POST = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-coupon-create", user.id, 30, 3600);
  const input = await json(request, couponSchema);
  return respond({ coupon: await createCoupon(user.id, input) }, 201);
});

export const PATCH = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-coupon-update", user.id, 60, 300);
  const input = await json(request, couponToggleSchema);
  const coupon = await updateCoupon(user.id, input.id, input.active);
  return respond({ coupon });
});
