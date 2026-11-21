import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Appointments } from "@/components/appointments";
import { CancellationPolicy } from "@/components/cancellation-policy";
import { CouponManager } from "@/components/coupon-manager";
import { PaymentSettings } from "@/components/payment-settings";
import { ProviderFinance } from "@/components/provider-finance";
import { ProviderReviewManager } from "@/components/provider-review-manager";
import { NotificationCenter } from "@/components/notification-center";
import { NotificationPreferences } from "@/components/notification-preferences";
import { StudioProfile, StudioServices, StudioTeam } from "@/components/studio";
import { Button } from "@/components/ui/button";
import { WalkInForm } from "@/components/walk-in-form";
import { pageUser, type Viewer } from "@/lib/auth";
import { listBookings } from "@/lib/bookings";
import { db } from "@/lib/db";
import { getProviderFinance } from "@/lib/finance";
import { studioFor, type Studio } from "@/lib/provider";
import { requestTime } from "@/lib/request-time";
import { daySchedule, localDate } from "@/lib/schedule";

export const metadata: Metadata = { title: "Studio dashboard" };

const sections = [
  ["profile", "Profile & verification"],
  ["team", "Locations & availability"],
  ["services", "Services"],
  ["payments", "Payments & tax"],
  ["finance", "Earnings & payouts"],
  ["coupons", "Coupons & offers"],
  ["reviews", "Customer reviews"],
  ["notifications", "Notifications"],
  ["appointments", "Appointment calendar"],
] as const;

type CalendarQuery = { branch?: string; date?: string; view?: string };

async function StudioCalendar({
  studio,
  user,
  query,
}: {
  studio: Studio;
  user: Viewer;
  query: CalendarQuery;
}) {
  const now = requestTime();
  const branch = studio.branches.find(({ id }) => id === query.branch) ?? studio.branches[0];
  const date = branch && (z.iso.date().safeParse(query.date).data ?? localDate(now, branch.timeZone));
  const day = branch && date ? daySchedule(date, branch.timeZone, []) : undefined;
  const all = query.view === "all" || !day;
  const appointments = await listBookings(
    user,
    !all && branch && day
      ? { branchId: branch.id, from: new Date(day.start), until: new Date(day.end) }
      : undefined,
  );
  const closed = !all && branch?.holidays.find((holiday) => holiday.date === date);

  return (
    <>
      <section className="panel studio-stack">
        <h2>Appointment calendar</h2>
        {branch && date && (
          <form action="/studio" className="form-stack" aria-label="Filter the appointment calendar">
            <input type="hidden" name="tab" value="appointments" />
            <div className="two-grid studio-form-grid">
              <label>
                Location
                <select name="branch" defaultValue={branch.id}>
                  {studio.branches.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Date
                <input type="date" name="date" defaultValue={date} required />
              </label>
            </div>
            <div className="action-row">
              <Button type="submit" size="sm">
                Show day
              </Button>
              <Link className="button button-ghost" href="/studio?tab=appointments&view=all">
                All appointments
              </Link>
            </div>
          </form>
        )}
        {closed && (
          <p className="muted">Location closed for the holiday{closed.reason && ` · ${closed.reason}`}</p>
        )}
      </section>
      {studio.type === "SHOP" && studio.status === "APPROVED" && <WalkInForm studio={studio} />}
      <Appointments items={appointments} role={user.role} now={now} />
    </>
  );
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<CalendarQuery & { tab?: string }>;
}) {
  const query = await searchParams;
  const { tab } = query;
  const section = sections.find(([id]) => id === tab)?.[0] ?? "profile";
  const user = await pageUser(`/studio?tab=${section}`, "PROVIDER", "STAFF");
  if (user.role === "STAFF") {
    const staff = await db.staff.findUnique({
      where: { userId: user.id },
      select: { active: true, provider: { select: { displayName: true } } },
    });
    return (
      <section className="wrap page-space dashboard">
        <div className="section-head">
          <h1>Team appointments</h1>
          <p>{staff?.provider.displayName}</p>
        </div>
        {staff?.active ? (
          <Appointments items={await listBookings(user)} role={user.role} now={requestTime()} />
        ) : (
          <div className="empty-state">Your staff account is inactive.</div>
        )}
      </section>
    );
  }
  const studio = await studioFor(user.id);
  return (
    <section className="wrap page-space dashboard">
      <div className="section-head">
        <div className="dash-heading">
          <div>
            <p className="eyebrow">{studio.type === "ARTIST" ? "ARTIST DASHBOARD" : "SALON DASHBOARD"}</p>
            <h1>{studio.displayName}</h1>
          </div>
          <span className="status" data-status={studio.status}>
            {studio.status === "PENDING"
              ? "In review"
              : studio.status.charAt(0) + studio.status.toLowerCase().slice(1)}
          </span>
        </div>
        {studio.reviewNote && <p>{studio.reviewNote}</p>}
        {studio.status === "APPROVED" && (
          <Link className="back-link" href={`/providers/${studio.slug}`}>
            View public listing
          </Link>
        )}
      </div>
      <nav className="dashboard-nav" aria-label="Studio navigation">
        {sections.map(([id, label]) => (
          <Link href={`/studio?tab=${id}`} key={id} aria-current={id === section ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <NotificationCenter />
      {section === "profile" && <StudioProfile studio={studio} />}
      {section === "team" && <StudioTeam studio={studio} />}
      {section === "services" && (
        <StudioServices
          studio={studio}
          categories={await db.serviceCategory.findMany({
            orderBy: { position: "asc" },
            select: { id: true, name: true },
          })}
        />
      )}
      {section === "payments" && (
        <div className="studio-stack">
          <PaymentSettings settings={studio} />
          <CancellationPolicy policy={studio} />
        </div>
      )}
      {section === "finance" && (
        <ProviderFinance
          initial={await getProviderFinance(studio.id)}
          staff={await db.staff.findMany({
            where: { providerId: studio.id, active: true },
            orderBy: { name: "asc" },
            select: { id: true, name: true },
          })}
          minimumPayoutPaise={
            (await db.financeSetting.findUniqueOrThrow({ where: { id: "platform" } })).minimumPayoutPaise
          }
        />
      )}
      {section === "coupons" && (
        <CouponManager
          scope="provider"
          categories={await db.serviceCategory.findMany({
            orderBy: { position: "asc" },
            select: { id: true, name: true },
          })}
        />
      )}
      {section === "reviews" && <ProviderReviewManager />}
      {section === "notifications" && <NotificationPreferences />}
      {section === "appointments" && <StudioCalendar studio={studio} user={user} query={query} />}
    </section>
  );
}
