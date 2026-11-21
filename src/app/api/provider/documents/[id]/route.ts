import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, route } from "@/lib/http";
import { unseal } from "@/lib/secrets";

export const GET = route(async (_request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("PROVIDER", "ADMIN");
  const { id } = await params;
  const upload = await db.providerDocument.findFirst({
    where: { id, ...(user.role === "ADMIN" ? {} : { provider: { ownerId: user.id } }) },
  });
  if (!upload) throw new HttpError(404, "Document not found.");
  const content = unseal(upload.content, `document:${upload.providerId}`);
  await db.auditLog.create({
    data: { actorId: user.id, targetId: upload.providerId, action: "STUDIO_DOCUMENT_ACCESSED" },
  });
  return new Response(Uint8Array.from(content), {
    headers: {
      "Content-Type": upload.contentType,
      "Content-Disposition": `attachment; filename="${upload.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
