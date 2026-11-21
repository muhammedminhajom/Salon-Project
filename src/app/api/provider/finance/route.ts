import { requireUser, limit } from "@/lib/auth";
import { db } from "@/lib/db";
import { getProviderFinance, requestPayout } from "@/lib/finance";
import { HttpError, json, respond, route } from "@/lib/http";
import { payoutRequestSchema } from "@/lib/schemas";
import { z } from "zod";

const dateSchema = z.iso.date();
const day = (value: string | null) => {
  if (!value) return undefined;
  const parsed = dateSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Use an ISO calendar date.");
  return new Date(value + "T00:00:00.000Z");
};

export const GET = route(async (request) => {
  const user = await requireUser("PROVIDER");
  const provider = await db.providerProfile.findUnique({
    where: { ownerId: user.id },
    select: { id: true },
  });
  if (!provider) throw new HttpError(404, "Provider profile not found.");
  const query = new URL(request.url).searchParams;
  const from = day(query.get("from"));
  const until = day(query.get("until"));
  const end = until ? new Date(until.getTime() + 86_400_000) : undefined;
  const result = await getProviderFinance(provider.id, {
    from,
    until: end,
    staffId: query.get("staff") || undefined,
    asCsv: query.get("format") === "csv",
  });
  if (typeof result === "string")
    return new Response(result, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="provider-earnings.csv"',
        "Cache-Control": "no-store",
      },
    });
  return respond(result);
});

export const POST = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("provider-payout-request", user.id, 10, 3600);
  const provider = await db.providerProfile.findUnique({
    where: { ownerId: user.id },
    select: { id: true },
  });
  if (!provider) throw new HttpError(404, "Provider profile not found.");
  const payout = await requestPayout(provider.id, await json(request, payoutRequestSchema), user.id);
  return respond({ payout }, 201);
});
