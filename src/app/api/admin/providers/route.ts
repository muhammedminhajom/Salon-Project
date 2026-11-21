import { requireUser } from "@/lib/auth";
import { json, respond, route } from "@/lib/http";
import { adminOverview, decisionSchema, reviewProvider } from "@/lib/provider";

export const GET = route(async () => {
  await requireUser("ADMIN");
  return respond(await adminOverview());
});

export const PATCH = route(async (request) => {
  const user = await requireUser("ADMIN");
  return respond({ provider: await reviewProvider(user, await json(request, decisionSchema)) });
});
