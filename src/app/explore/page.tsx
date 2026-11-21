import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { ListingCard } from "@/components/market";
import { Button } from "@/components/ui/button";
import { categories, discover, filtersSchema, urlFilters } from "@/lib/catalog";

export const metadata: Metadata = { title: "Explore salons and artists" };
export const dynamic = "force-dynamic";

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = filtersSchema.safeParse(urlFilters(await searchParams));
  const filters = parsed.success ? parsed.data : {};
  const listings = await discover(filters);
  return (
    <>
      <div className="page-top">
        <div className="wrap">
          <h1>{filters.offers ? "Beauty offers" : "Find your beauty match"}</h1>
          <p>Explore verified salons and freelance beauty artists.</p>
        </div>
      </div>
      <section className="wrap explorer">
        {filters.offers && (
          <Link className="back-link" href="/explore">
            All listings
          </Link>
        )}
        <form className="filter-panel panel" action="/explore" aria-label="Filter listings">
          <label className="span-two">
            Search
            <input
              name="q"
              maxLength={100}
              defaultValue={filters.q}
              placeholder="Service, salon, or artist"
            />
          </label>
          <label>
            Location
            <input
              name="city"
              maxLength={80}
              defaultValue={filters.city}
              placeholder="City or neighbourhood"
            />
          </label>
          <label>
            Category
            <select name="category" defaultValue={filters.category ?? ""}>
              <option value="">All categories</option>
              {categories.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select name="type" defaultValue={filters.type ?? ""}>
              <option value="">All providers</option>
              <option value="SHOP">Salons</option>
              <option value="ARTIST">Independent artists</option>
            </select>
          </label>
          <label>
            Appointment
            <select name="mode" defaultValue={filters.mode ?? ""}>
              <option value="">Any appointment</option>
              <option value="home">Home visits</option>
              <option value="venue">At a salon</option>
            </select>
          </label>
          <label>
            Maximum price (₹)
            <input
              type="number"
              min={0}
              max={50000}
              name="maxPrice"
              placeholder="Any price"
              defaultValue={filters.maxPrice}
            />
          </label>
          <label>
            Rating
            <select name="rating" defaultValue={filters.rating ?? ""}>
              <option value="">Any rating</option>
              <option value="4.5">4.5 or higher</option>
              <option value="4">4.0 or higher</option>
            </select>
          </label>
          <label>
            Sort by
            <select name="sort" defaultValue={filters.sort ?? "recommended"}>
              <option value="recommended">Recommended</option>
              <option value="rating">Top rated</option>
              <option value="price">Lowest price</option>
            </select>
          </label>
          <label className="checkbox-label filter-offers">
            <input type="checkbox" name="offers" value="1" defaultChecked={Boolean(filters.offers)} /> Offers
            only
          </label>
          <Button type="submit">
            <Search size={17} /> Find appointments
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/explore">Clear filters</Link>
          </Button>
        </form>
        {!parsed.success && (
          <p className="form-error" role="alert">
            One or more filters could not be applied.
          </p>
        )}
        <div className="result-count">
          <h2>
            {listings.length} {listings.length === 1 ? "result" : "results"}
          </h2>
        </div>
        {listings.length ? (
          <div className="listing-grid">
            {listings.map((listing) => (
              <ListingCard listing={listing} key={listing.id} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h3>No matches found</h3>
            <p>Try a different location or clear some filters.</p>
            <Button asChild variant="outline">
              <Link href="/explore">See all listings</Link>
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
