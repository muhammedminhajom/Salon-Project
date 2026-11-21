import { limit, requireUser } from "@/lib/auth";
import { createWalkIn } from "@/lib/bookings";
import { json, respond, route } from "@/lib/http";
import { walkInSchema } from "@/lib/schemas";

export const POST = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("walk-in-create", user.id, 60, 300);
  const result = await createWalkIn(user, await json(request, walkInSchema));
  return respond({ booking: result.booking }, result.created ? 201 : 200);
});
