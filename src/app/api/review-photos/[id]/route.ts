import { db } from "@/lib/db";
import { HttpError, route } from "@/lib/http";

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const photo = await db.reviewPhoto.findFirst({
    where: {
      id: (await context.params).id,
      review: { status: "PUBLISHED", provider: { status: "APPROVED" } },
    },
    select: { content: true, contentType: true },
  });
  if (!photo) throw new HttpError(404, "Review photo not found.");
  return new Response(photo.content, {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
