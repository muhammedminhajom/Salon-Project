import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { respond, route } from "@/lib/http";

export const GET = route(async () => {
  await requireUser("ADMIN");
  const deliveries = await db.notificationDelivery.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      notification: {
        select: {
          eventType: true,
          channel: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
        },
      },
    },
  });
  return respond({ deliveries });
});
