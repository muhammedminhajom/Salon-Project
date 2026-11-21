import { requireUser, limit } from "@/lib/auth";
import { getAdminPayouts, processPayouts } from "@/lib/finance";
import { json, respond, route } from "@/lib/http";
import { payoutActionSchema } from "@/lib/schemas";

export const GET = route(async () => {
  await requireUser("ADMIN");
  return respond({ payouts: await getAdminPayouts() });
});

export const PATCH = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-payout-action", user.id, 60, 300);
  const payouts = await processPayouts(user.id, await json(request, payoutActionSchema));
  return respond({ payouts });
});
