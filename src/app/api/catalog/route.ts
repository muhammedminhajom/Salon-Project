import { discover, filtersSchema, urlFilters } from "@/lib/catalog";
import { respond, route } from "@/lib/http";

export const GET = route(async (request) =>
  respond({ listings: await discover(filtersSchema.parse(urlFilters(new URL(request.url).searchParams))) }),
);
