import { limit, requireUser } from "@/lib/auth";
import {
  listNotificationTemplates,
  previewNotificationTemplate,
  saveNotificationTemplate,
} from "@/lib/notifications";
import { json, respond, route } from "@/lib/http";
import { notificationTemplateSchema } from "@/lib/schemas";

export const GET = route(async () => {
  await requireUser("ADMIN");
  return respond({ templates: await listNotificationTemplates() });
});

export const PUT = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-notification-template", user.id, 60, 300);
  const input = await json(request, notificationTemplateSchema);
  return respond({ template: await saveNotificationTemplate(user.id, input) });
});

export const POST = route(async (request) => {
  await requireUser("ADMIN");
  const input = await json(request, notificationTemplateSchema);
  return respond({ preview: await previewNotificationTemplate(input) });
});
