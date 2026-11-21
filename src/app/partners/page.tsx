import type { Metadata } from "next";
import Link from "next/link";
import { Brush, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getViewer, roleHome } from "@/lib/auth";

export const metadata: Metadata = { title: "List your business" };

export default async function PartnersPage() {
  const user = await getViewer();
  return (
    <section className="wrap page-space">
      <div className="section-head">
        <p className="eyebrow">FOR BEAUTY PROFESSIONALS</p>
        <h1>Grow your beauty business</h1>
        <p>Publish your service menu and get booked on your schedule.</p>
      </div>
      <div className="two-grid">
        {[
          {
            type: "SHOP",
            name: "Salon or shop",
            icon: Store,
            description: "Manage branches, staff schedules, and your service menu from one dashboard.",
          },
          {
            type: "ARTIST",
            name: "Freelance artist",
            icon: Brush,
            description: "Share your portfolio, set your travel area, and manage your solo calendar.",
          },
        ].map(({ type, name, icon: Icon, description }) => (
          <article className="panel partner-card" key={type}>
            <Icon size={32} />
            <h2>{name}</h2>
            <p>{description}</p>
            <Button asChild>
              <Link href={user ? roleHome(user.role) : `/account?mode=register&type=${type}`}>
                {user ? "Go to your dashboard" : `Join as ${type === "SHOP" ? "a salon" : "an artist"}`}
              </Link>
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
