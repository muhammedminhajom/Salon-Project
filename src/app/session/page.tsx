import { SessionRestore } from "@/components/session-restore";
import { safeNext } from "@/lib/http";

export default async function SessionPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <section className="wrap page-space">
      <SessionRestore next={safeNext(typeof next === "string" ? next : "/")} />
    </section>
  );
}
