import { limit, requireUser } from "@/lib/auth";
import { bodyBytes, HttpError, respond, route } from "@/lib/http";
import { addDocument } from "@/lib/provider";

export const POST = route(async (request) => {
  const user = await requireUser("PROVIDER");
  await limit("studio-documents", user.id, 10, 3600);
  const content = await bodyBytes(request, 3 * 1024 * 1024);
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const signatures: Record<string, Buffer> = {
    "application/pdf": Buffer.from("%PDF-"),
    "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
    "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
  const signature =
    contentType && Object.hasOwn(signatures, contentType) ? signatures[contentType] : undefined;
  if (!contentType || !signature || !content.subarray(0, signature.length).equals(signature))
    throw new HttpError(415, "Upload a PDF, JPEG, or PNG file.");
  const filename = (request.headers.get("x-file-name") ?? "verification-document")
    .replace(/[^a-zA-Z0-9_. -]/g, "_")
    .slice(0, 120);
  return respond({ document: await addDocument(user, { content, contentType, filename }) }, 201);
});
