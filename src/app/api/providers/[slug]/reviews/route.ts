import { HttpError, respond, route } from "@/lib/http";
import { listPublicReviews } from "@/lib/reviews";

export const GET = route(async (request, context: { params: Promise<{ slug: string }> }) => {
  const pageValue = new URL(request.url).searchParams.get("page") ?? "1";
  const page = Number(pageValue);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new HttpError(400, "Review page is invalid.");
  return respond(await listPublicReviews((await context.params).slug, page));
});
