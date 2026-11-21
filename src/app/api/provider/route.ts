import { limit, requireUser } from "@/lib/auth";
import { executeStudio, providerCommand, studioFor } from "@/lib/provider";
import { json, respond, route } from "@/lib/http";

export const GET = route(async () =>
  respond({ studio: await studioFor((await requireUser("PROVIDER")).id) }),
);

export const POST = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("studio-write", user.id, 90, 300);
  return respond({ result: await executeStudio(user, await json(request, providerCommand)) });
});
