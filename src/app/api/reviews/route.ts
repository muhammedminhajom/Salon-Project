import { limit, requireUser } from "@/lib/auth";
import { bodyBytes, HttpError, route } from "@/lib/http";
import { submitReview, type ReviewPhotoInput } from "@/lib/reviews";
import { reviewSchema } from "@/lib/schemas";

const signatures: Record<string, Buffer> = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": Buffer.from("RIFF"),
};

function validImage(contentType: string, content: Buffer) {
  if (contentType === "image/webp")
    return content.length >= 12 && content.toString("ascii", 8, 12) === "WEBP";
  const signature = signatures[contentType];
  return Boolean(
    signature &&
    content.length >= signature.length &&
    content.subarray(0, signature.length).equals(signature),
  );
}

export const POST = route(async (request) => {
  const user = await requireUser("CUSTOMER");
  await limit("review-submit", user.id, 20, 3600);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data"))
    throw new HttpError(415, "Send review details and photos as a multipart form.");
  const bytes = await bodyBytes(request, 3_300_000);
  const form = await new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: bytes,
  }).formData();
  const input = reviewSchema.parse({
    bookingId: String(form.get("bookingId") ?? ""),
    rating: Number(form.get("rating")),
    body: String(form.get("body") ?? ""),
  });
  const photoFields = form
    .getAll("photos")
    .filter((item): item is File => item instanceof File && item.size > 0);
  if (photoFields.length > 3) throw new HttpError(400, "Attach no more than three photos.");
  const photos: ReviewPhotoInput[] = [];
  for (const file of photoFields) {
    if (file.size > 1_000_000) throw new HttpError(413, "Each review photo must be 1 MB or smaller.");
    const content = Buffer.from(await file.arrayBuffer());
    if (!validImage(file.type, content))
      throw new HttpError(415, "Review photos must be valid JPEG, PNG, or WebP images.");
    photos.push({ contentType: file.type, content });
  }
  return Response.json(
    { review: await submitReview(user, input, photos) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
