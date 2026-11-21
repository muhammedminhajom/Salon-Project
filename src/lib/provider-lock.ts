import type { Prisma } from "@prisma/client";
import { HttpError } from "@/lib/http";

export async function lockProvider(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "ProviderProfile" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw new HttpError(404, "Provider not found.");
}
