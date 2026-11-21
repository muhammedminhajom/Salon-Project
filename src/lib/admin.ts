import { viewerSelect } from "@/lib/auth";
import { db } from "@/lib/db";

const PAGE_SIZE = 25;

export async function listAdminUsers(cursor?: string) {
  const users = await db.user.findMany({
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: PAGE_SIZE + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { ...viewerSelect, createdAt: true },
  });
  const page = users.slice(0, PAGE_SIZE);
  return { users: page, nextCursor: users.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null };
}
