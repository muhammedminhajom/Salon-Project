import { listAdminUsers } from "@/lib/admin";
import { requireUser } from "@/lib/auth";
import { respond, route } from "@/lib/http";
import { id } from "@/lib/schemas";

export const GET = route(async (request) => {
  await requireUser("ADMIN");
  const cursor = id.optional().parse(new URL(request.url).searchParams.get("cursor") ?? undefined);
  return respond(await listAdminUsers(cursor));
});
