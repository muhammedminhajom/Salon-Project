import Image from "next/image";
import Link from "next/link";
import {
  BadgeCheck,
  Brush,
  Flower,
  Hand,
  House,
  MapPin,
  Scissors,
  Search,
  Sparkles,
  SprayCan,
  Star,
  Waves,
  Gem,
} from "lucide-react";
import { categories, minPrice, type Listing } from "@/lib/catalog";
import { money } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const categoryIcons = [Scissors, Sparkles, Brush, Hand, Waves, Gem, Flower, SprayCan];
const categoryColors = [
  "#f8e1e6",
  "#f9eadb",
  "#f0e5f5",
  "#fae4ee",
  "#e6eee3",
  "#f7e9d5",
  "#efead9",
  "#e6e9f2",
];

export function MarketSearch({ q = "", city = "" }: { q?: string; city?: string }) {
  return (
    <form className="market-search" action="/explore" aria-label="Find an appointment">
      <label>
        <Search size={20} />
        <input
          name="q"
          maxLength={100}
          defaultValue={q}
          aria-label="Service, salon, or artist"
          placeholder="Service, salon, or artist"
        />
      </label>
      <label>
        <MapPin size={19} />
        <input
          name="city"
          maxLength={80}
          defaultValue={city}
          aria-label="City or neighbourhood"
          placeholder="City or neighbourhood"
        />
      </label>
      <Button type="submit" size="lg">
        Search
      </Button>
    </form>
  );
}

export function CategoryPicker() {
  return (
    <div className="category-grid">
      {categories.map(([id, label], index) => {
        const Icon = categoryIcons[index];
        return (
          <Link className="category" key={id} href={`/explore?category=${id}`}>
            <span style={{ background: categoryColors[index] }}>
              <Icon size={27} strokeWidth={1.55} />
            </span>
            {label}
          </Link>
        );
      })}
    </div>
  );
}

export function ListingCard({ listing }: { listing: Listing }) {
  const offer = listing.services.some((service) => service.listPaise);
  return (
    <article className="listing-card">
      <Link className="listing-image" href={`/providers/${listing.slug}`} tabIndex={-1} aria-hidden="true">
        {listing.image ? (
          <Image
            src={listing.image}
            alt=""
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1200px) 33vw, 384px"
            unoptimized={!listing.image.startsWith("/images/")}
          />
        ) : (
          <Flower size={50} strokeWidth={1.1} />
        )}
        <span className="card-flag">
          {offer ? "Special offer" : listing.type === "ARTIST" ? "Independent artist" : "Salon"}
        </span>
      </Link>
      <div className="listing-body">
        <div className="listing-title">
          <h3>
            <Link href={`/providers/${listing.slug}`}>{listing.displayName}</Link>
          </h3>
          <BadgeCheck size={18} className="verified" aria-label="Verified provider" />
        </div>
        <p className="listing-meta">
          <MapPin size={15} />
          {[listing.area, listing.city].filter(Boolean).join(", ")}
          {listing.rating !== null && (
            <span className="listing-rating">
              <Star size={14} fill="currentColor" /> <strong>{listing.rating.toFixed(1)}</strong> (
              {listing.reviewCount})
            </span>
          )}
        </p>
        <p className="listing-specialties">
          {listing.specialties.join(" · ") || (listing.type === "ARTIST" ? "Beauty artist" : "Beauty salon")}
        </p>
        <div className="listing-bottom">
          <span>
            From <strong>{money(minPrice(listing))}</strong>
          </span>
          {listing.homeEnabled && (
            <span className="home-note">
              <House size={14} /> Home visits
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
