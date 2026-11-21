import { requireUser, limit } from "@/lib/auth";
import { updateCommissionOverride } from "@/lib/finance";
import { json, respond, route } from "@/lib/http";
import { commissionOverrideSchema } from "@/lib/schemas";

export const PATCH = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-commission-override", user.id, 60, 300);
  const result = await updateCommissionOverride(user.id, await json(request, commissionOverrideSchema));
  return respond({ result });
});
