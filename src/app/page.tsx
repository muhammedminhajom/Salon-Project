import Image from "next/image";
import Link from "next/link";
import { BadgeCheck, CalendarCheck, House, MapPin } from "lucide-react";
import { CategoryPicker, ListingCard, MarketSearch } from "@/components/market";
import { Button } from "@/components/ui/button";
import { discover } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const listings = (await discover()).slice(0, 3);
  return (
    <>
      <section className="hero">
        <div className="hero-art">
          <Image
            src="/images/hero.webp"
            alt="Woman with soft rose makeup in warm studio light"
            fill
            sizes="(max-width: 640px) 100vw, 67vw"
            preload
          />
        </div>
        <div className="hero-inner wrap">
          <div className="hero-copy">
            <p className="eyebrow hero-location">
              <MapPin size={15} /> BEAUTY &amp; WELLNESS IN KOCHI
            </p>
            <h1>
              Make time
              <br /> <em>for you.</em>
            </h1>
            <p className="hero-description">
              Find your new favourite salon or book a beauty artist who comes to you.
            </p>
            <MarketSearch city="Kochi" />
          </div>
        </div>
      </section>
      <div className="benefits">
        <div className="wrap benefit-row">
          <span>
            <BadgeCheck size={21} /> Verified local professionals
          </span>
          <span>
            <CalendarCheck size={21} /> Real-time availability
          </span>
          <span>
            <House size={21} /> In salon or at home
          </span>
        </div>
      </div>
      <section className="wrap category-section" aria-labelledby="categories">
        <div className="section-head center">
          <h2 id="categories">What are you looking for?</h2>
        </div>
        <CategoryPicker />
      </section>
      <section className="featured-section" aria-labelledby="featured">
        <div className="wrap">
          <div className="section-head section-action">
            <div>
              <p className="eyebrow">THE KOCHI EDIT</p>
              <h2 id="featured">Featured near you</h2>
              <p>Meet the local salons and artists you can book today.</p>
            </div>
            <Button variant="outline" asChild>
              <Link href="/explore">View all</Link>
            </Button>
          </div>
          {listings.length ? (
            <div className="listing-grid">
              {listings.map((listing) => (
                <ListingCard listing={listing} key={listing.id} />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              New salons and beauty artists will appear here after verification.
            </div>
          )}
        </div>
      </section>
      <section className="wrap partner-promo">
        <div>
          <h2>Put your talent on the map.</h2>
          <p>Join Bloom &amp; Blush as a salon or independent beauty artist.</p>
        </div>
        <Button asChild>
          <Link href="/partners">List your business</Link>
        </Button>
      </section>
    </>
  );
}
