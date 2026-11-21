import { limit, requireUser } from "@/lib/auth";
import { json, respond, route } from "@/lib/http";
import { replyToReview } from "@/lib/reviews";
import { reviewReplySchema } from "@/lib/schemas";

export const PATCH = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("PROVIDER");
  await limit("review-reply", user.id, 30, 3600);
  return respond({
    reply: await replyToReview(user, (await context.params).id, await json(request, reviewReplySchema)),
  });
});
