import { requireUser, limit } from "@/lib/auth";
import { db } from "@/lib/db";
import { savePayoutDetails } from "@/lib/finance";
import { HttpError, json, respond, route } from "@/lib/http";
import { payoutDetailsSchema } from "@/lib/schemas";

export const PUT = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("provider-payout-details", user.id, 10, 3600);
  const provider = await db.providerProfile.findUnique({
    where: { ownerId: user.id },
    select: { id: true },
  });
  if (!provider) throw new HttpError(404, "Provider profile not found.");
  return respond({
    payoutDetails: await savePayoutDetails(provider.id, await json(request, payoutDetailsSchema), user.id),
  });
});
