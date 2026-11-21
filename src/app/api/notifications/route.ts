import { limit, requireUser } from "@/lib/auth";
import { notificationCenter, markNotificationsRead } from "@/lib/notifications";
import { json, respond, route } from "@/lib/http";
import { notificationReadSchema } from "@/lib/schemas";

export const GET = route(async () => {
  const user = await requireUser();
  return respond(await notificationCenter(user.id));
});

export const PATCH = route(async (request) => {
  const user = await requireUser();
  await limit("notification-read", user.id, 60, 300);
  const input = await json(request, notificationReadSchema);
  return respond(await markNotificationsRead(user.id, input.ids));
});
