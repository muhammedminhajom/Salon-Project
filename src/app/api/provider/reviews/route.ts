import { requireUser } from "@/lib/auth";
import { providerReviews } from "@/lib/reviews";
import { respond, route } from "@/lib/http";

export const GET = route(async () =>
  respond({ reviews: await providerReviews(await requireUser("PROVIDER")) }),
);
