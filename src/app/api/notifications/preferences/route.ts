import { requireUser } from "@/lib/auth";
import { getNotificationPreferences, saveNotificationPreferences } from "@/lib/notifications";
import { json, respond, route } from "@/lib/http";
import { notificationPreferenceSchema } from "@/lib/schemas";

export const GET = route(async () => {
  const user = await requireUser();
  return respond({ preferences: await getNotificationPreferences(user.id) });
});

export const PUT = route(async (request) => {
  const user = await requireUser();
  const input = await json(request, notificationPreferenceSchema);
  return respond({ preferences: await saveNotificationPreferences(user.id, input) });
});
