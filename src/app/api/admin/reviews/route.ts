import { limit, requireUser } from "@/lib/auth";
import { adminReviewQueue, moderateReview } from "@/lib/reviews";
import { json, respond, route } from "@/lib/http";
import { reviewModerationSchema } from "@/lib/schemas";
import { id } from "@/lib/schemas";
import { z } from "zod";

export const GET = route(async () => {
  await requireUser("ADMIN");
  return respond({ reviews: await adminReviewQueue() });
});

export const PATCH = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-review-moderation", user.id, 60, 300);
  const input = await json(request, z.object({ id, ...reviewModerationSchema.shape }));
  const { id: reviewId, ...decision } = input;
  return respond({ review: await moderateReview(user.id, reviewId, decision) });
});
