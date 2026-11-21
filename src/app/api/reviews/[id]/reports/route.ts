import { limit, requireUser } from "@/lib/auth";
import { json, respond, route } from "@/lib/http";
import { reportReview } from "@/lib/reviews";
import { reviewReportSchema } from "@/lib/schemas";

export const POST = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("CUSTOMER");
  await limit("review-report", user.id, 10, 3600);
  return respond(
    { report: await reportReview(user, (await context.params).id, await json(request, reviewReportSchema)) },
    201,
  );
});
