import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, CalendarDays, Flower, House, MapPin, Star } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { BookingForm } from "@/components/booking-form";
import { ReviewReportButton } from "@/components/review-report-button";
import { getViewer } from "@/lib/auth";
import { publicProfile } from "@/lib/catalog";
import { razorpayEnabled } from "@/lib/razorpay";
import { listPublicReviews } from "@/lib/reviews";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ services?: string; page?: string }>;
};
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await publicProfile((await params).slug);
  return profile
    ? { title: `${profile.displayName} in ${profile.city}`, description: profile.description }
    : { title: "Provider unavailable" };
}

export default async function ProviderPage({ params, searchParams }: Props) {
  const [profile, viewer, query] = await Promise.all([
    publicProfile((await params).slug),
    getViewer(),
    searchParams,
  ]);
  if (!profile) notFound();
  const requestedPage = Number(query.page ?? "1");
  const reviewPage = await listPublicReviews(
    profile.slug,
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  );
  const dateLimits = Object.fromEntries(
    profile.branches.map(({ id, timeZone }) => {
      const today = Temporal.Now.plainDateISO(timeZone);
      return [id, { today: today.toString(), max: today.add({ days: 60 }).toString() }];
    }),
  );
  const services = typeof query.services === "string" ? query.services.split(",").slice(0, 8) : [];
  const artist = profile.type === "ARTIST";
  return (
    <section className="wrap page-space profile-page">
      <Link className="back-link" href="/explore">
        Explore providers
      </Link>
      <div className="profile-cover">
        {profile.image ? (
          <Image
            src={profile.image}
            alt={`${profile.displayName} showcase`}
            fill
            sizes="(max-width: 1200px) 100vw, 1184px"
            unoptimized={!profile.image.startsWith("/images/")}
          />
        ) : (
          <Flower size={64} strokeWidth={1} />
        )}
      </div>
      <div className="profile-heading">
        <p className="eyebrow">{artist ? "INDEPENDENT BEAUTY ARTIST" : "SALON"}</p>
        <h1>
          {profile.displayName} <BadgeCheck className="verified" aria-label="Verified provider" />
        </h1>
        <p className="listing-meta">
          <MapPin size={17} /> {[profile.area, profile.city].filter(Boolean).join(", ")}
          {profile.rating !== null && (
            <span className="listing-rating">
              <Star size={16} fill="currentColor" /> <strong>{profile.rating.toFixed(1)}</strong> (
              {profile.reviewCount})
            </span>
          )}
        </p>
      </div>
      <div className="profile-grid">
        <div className="profile-details">
          <section className="panel">
            <h2>About {profile.displayName}</h2>
            <p>{profile.description}</p>
            {profile.specialties.length > 0 && (
              <div className="pill-row">
                {Array.from(new Set(profile.specialties)).map((item) => (
                  <span key={item} className="pill">
                    {item}
                  </span>
                ))}
              </div>
            )}
            {profile.homeEnabled && (
              <p className="icon-line">
                <House size={18} /> Home visits within {profile.travelRadiusKm} km of the service base
              </p>
            )}
          </section>
          {profile.gallery.length > 0 && (
            <section className="panel">
              <h2>{artist ? "Portfolio" : "Gallery"}</h2>
              <div className="gallery-grid">
                {Array.from(new Set(profile.gallery)).map((image, index) => (
                  <Image
                    key={image}
                    src={image}
                    alt={`${profile.displayName} portfolio image ${index + 1}`}
                    width={460}
                    height={400}
                    sizes="(max-width: 640px) 30vw, 200px"
                    unoptimized={!image.startsWith("/images/")}
                  />
                ))}
              </div>
            </section>
          )}
          {profile.branches.length > 0 && (
            <section className="panel">
              <h2>{artist ? "Service area" : "Locations"}</h2>
              {profile.branches.map((branch) => (
                <div className="location-item" key={branch.id}>
                  <MapPin size={19} />
                  <div>
                    <strong>{branch.name}</strong>
                    <p>{artist ? `${profile.area}, ${profile.city}` : branch.address}</p>
                  </div>
                </div>
              ))}
            </section>
          )}
          {profile.staff.length > 0 && (
            <section className="panel">
              <h2>{artist ? "Working hours" : "Meet the team"}</h2>
              {profile.staff.map((person) => (
                <details className="team-detail" key={person.id}>
                  <summary>
                    {person.name} {person.title && <small>{person.title}</small>}
                    {person.rating !== null && (
                      <small>
                        {" "}
                        · {person.rating.toFixed(1)} rating ({person.reviewCount})
                      </small>
                    )}
                  </summary>
                  {person.windows.length ? (
                    <ul>
                      {person.windows.map((item) => (
                        <li key={item.id}>
                          {weekdays[item.dayOfWeek - 1]} · {clock(item.startMinute)}–{clock(item.endMinute)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Working hours haven’t been added yet.</p>
                  )}
                </details>
              ))}
            </section>
          )}
          <section className="panel">
            <h2>
              <CalendarDays size={22} /> Changes and cancellation
            </h2>
            <p>
              Cancel before your appointment starts. The refund preview shows any fees.
              {(profile.freeRefundHours ?? profile.cancelBeforeHours) > 0 &&
                ` Free cancellation until ${profile.freeRefundHours ?? profile.cancelBeforeHours} hours before the visit.`}
            </p>
          </section>
          <section className="panel studio-stack" aria-labelledby="provider-reviews">
            <div className="dash-heading">
              <h2 id="provider-reviews">Customer reviews</h2>
              <span>
                {reviewPage.total} review{reviewPage.total === 1 ? "" : "s"}
              </span>
            </div>
            {reviewPage.reviews.length ? (
              reviewPage.reviews.map((review) => (
                <article className="review-item" key={review.id}>
                  <div className="dash-heading">
                    <h3>
                      {review.customer.name} · {review.rating} / 5
                    </h3>
                    <span className="muted">
                      {review.staff.name} · {new Date(review.createdAt).toLocaleDateString("en-IN")}
                    </span>
                  </div>
                  {review.body && <p>{review.body}</p>}
                  {review.photos.length > 0 && (
                    <div className="gallery-grid">
                      {review.photos.map((photo, index) => (
                        <a href={`/api/review-photos/${photo.id}`} key={photo.id}>
                          <Image
                            src={`/api/review-photos/${photo.id}`}
                            alt={`Review photo ${index + 1}`}
                            width={280}
                            height={200}
                            unoptimized
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {review.providerReply && (
                    <p>
                      <strong>Provider reply:</strong> {review.providerReply}
                    </p>
                  )}
                  {viewer?.role === "CUSTOMER" && <ReviewReportButton reviewId={review.id} />}
                </article>
              ))
            ) : (
              <p>No reviews have been published yet.</p>
            )}
            {reviewPage.pageCount > 1 && (
              <nav className="action-row" aria-label="Review pages">
                {reviewPage.page > 1 && (
                  <Link
                    className="back-link"
                    href={`/providers/${profile.slug}?page=${reviewPage.page - 1}#provider-reviews`}
                  >
                    Previous reviews
                  </Link>
                )}
                {reviewPage.page < reviewPage.pageCount && (
                  <Link
                    className="back-link"
                    href={`/providers/${profile.slug}?page=${reviewPage.page + 1}#provider-reviews`}
                  >
                    Next reviews
                  </Link>
                )}
              </nav>
            )}
          </section>
        </div>
        <BookingForm
          profile={profile}
          viewerRole={viewer?.role}
          onlineEnabled={razorpayEnabled()}
          initialServices={services}
          dateLimits={dateLimits}
        />
      </div>
    </section>
  );
}
