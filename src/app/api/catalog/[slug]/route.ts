import { publicProfile } from "@/lib/catalog";
import { HttpError, respond, route } from "@/lib/http";

export const GET = route(async (_request, { params }: { params: Promise<{ slug: string }> }) => {
  const profile = await publicProfile((await params).slug);
  if (!profile) throw new HttpError(404, "Provider not found.");
  return respond({ profile });
});
