import type { Metadata } from "next";
import Link from "next/link";
import { AdminReview } from "@/components/admin-review";
import { AdminFinance } from "@/components/admin-finance";
import { CouponManager } from "@/components/coupon-manager";
import { AdminReviewModeration } from "@/components/admin-review-moderation";
import { AdminNotifications } from "@/components/admin-notifications";
import { NotificationCenter } from "@/components/notification-center";
import { Appointments } from "@/components/appointments";
import { listAdminUsers } from "@/lib/admin";
import { pageUser } from "@/lib/auth";
import { listBookings } from "@/lib/bookings";
import { adminOverview } from "@/lib/provider";
import { requestTime } from "@/lib/request-time";
import { db } from "@/lib/db";
import { id } from "@/lib/schemas";
import { money } from "@/lib/utils";

export const metadata: Metadata = { title: "Marketplace admin" };

const joinedDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

async function UserDirectory({ cursor }: { cursor?: string }) {
  const { users, nextCursor } = await listAdminUsers(cursor);
  return (
    <section className="panel studio-stack">
      <h2>Users</h2>
      {users.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <caption className="sr-only">Marketplace user accounts</caption>
            <thead>
              <tr>
                <th scope="col" className="p-2">
                  Name
                </th>
                <th scope="col" className="p-2">
                  Email
                </th>
                <th scope="col" className="p-2">
                  Phone
                </th>
                <th scope="col" className="p-2">
                  Role
                </th>
                <th scope="col" className="p-2">
                  Joined
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr key={item.id} className="border-t">
                  <th scope="row" className="p-2">
                    {item.name}
                  </th>
                  <td className="p-2">{item.email ?? "—"}</td>
                  <td className="p-2">{item.phone ?? "—"}</td>
                  <td className="p-2">{item.role}</td>
                  <td className="p-2">
                    <time dateTime={item.createdAt.toISOString()}>{joinedDate.format(item.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No users on this page.</p>
      )}
      <div className="action-row">
        {cursor && (
          <Link className="back-link" href="/admin?tab=users">
            First page
          </Link>
        )}
        {nextCursor && (
          <Link className="back-link" href={`/admin?tab=users&cursor=${encodeURIComponent(nextCursor)}`}>
            Next page
          </Link>
        )}
      </div>
    </section>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; cursor?: string }>;
}) {
  const { tab, cursor: value } = await searchParams;
  const section =
    tab === "bookings" ||
    tab === "users" ||
    tab === "finance" ||
    tab === "coupons" ||
    tab === "reviews" ||
    tab === "notifications"
      ? tab
      : "review";
  const cursor = section === "users" ? id.safeParse(value).data : undefined;
  const query =
    section === "review" ? "" : `?tab=${section}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const user = await pageUser(`/admin${query}`, "ADMIN");
  const data = await adminOverview();
  return (
    <section className="wrap page-space dashboard">
      <div className="section-head">
        <p className="eyebrow">MARKETPLACE ADMIN</p>
        <h1>Operations</h1>
        <p>Review providers and manage marketplace appointments.</p>
      </div>
      <div className="stat-grid">
        {[
          ["Customers", data.customers],
          ["Providers", data.providers],
          ["Bookings", data.bookings],
          ["Completed booking value", money(data.completedValue)],
        ].map(([label, value]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <nav className="dashboard-nav" aria-label="Admin navigation">
        <Link href="/admin" aria-current={section === "review" ? "page" : undefined}>
          Provider review
        </Link>
        <Link href="/admin?tab=bookings" aria-current={section === "bookings" ? "page" : undefined}>
          Appointments
        </Link>
        <Link href="/admin?tab=users" aria-current={section === "users" ? "page" : undefined}>
          Users
        </Link>
        <Link href="/admin?tab=finance" aria-current={section === "finance" ? "page" : undefined}>
          Finance
        </Link>
        <Link href="/admin?tab=coupons" aria-current={section === "coupons" ? "page" : undefined}>
          Coupons
        </Link>
        <Link href="/admin?tab=reviews" aria-current={section === "reviews" ? "page" : undefined}>
          Reviews
        </Link>
        <Link href="/admin?tab=notifications" aria-current={section === "notifications" ? "page" : undefined}>
          Notifications
        </Link>
      </nav>
      <NotificationCenter />
      {section === "finance" ? (
        <AdminFinance />
      ) : section === "notifications" ? (
        <AdminNotifications />
      ) : section === "reviews" ? (
        <AdminReviewModeration />
      ) : section === "coupons" ? (
        <CouponManager
          scope="admin"
          categories={await db.serviceCategory.findMany({
            orderBy: { position: "asc" },
            select: { id: true, name: true },
          })}
          providers={await db.providerProfile
            .findMany({
              where: { status: "APPROVED" },
              orderBy: { displayName: "asc" },
              select: { id: true, displayName: true },
            })
            .then((rows) => rows.map(({ id, displayName }) => ({ id, name: displayName })))}
        />
      ) : section === "bookings" ? (
        <Appointments items={await listBookings(user)} role={user.role} now={requestTime()} />
      ) : section === "users" ? (
        <UserDirectory cursor={cursor} />
      ) : (
        <>
          <h2>Provider applications</h2>
          {data.applications.length ? (
            <div className="studio-stack">
              {data.applications.map((item) => (
                <article className="panel" key={item.id}>
                  <div className="dash-heading">
                    <h3>{item.displayName}</h3>
                    <span className="status" data-status={item.status}>
                      {item.status}
                    </span>
                  </div>
                  <p className="muted">
                    {item.type === "ARTIST" ? "Freelance artist" : "Salon"} ·{" "}
                    {[item.area, item.city].filter(Boolean).join(", ")} ·{" "}
                    {item.owner.email || item.owner.name}
                  </p>
                  <p>{item.description}</p>
                  {item.reviewNote && <p className="muted">Last decision · {item.reviewNote}</p>}
                  {item.documents.length > 0 && (
                    <ul className="mini-list">
                      {item.documents.map(({ id, filename }) => (
                        <li key={id}>
                          <a href={`/api/provider/documents/${id}`}>{filename}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                  <AdminReview key={item.status} id={item.id} status={item.status} />
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">No applications to review.</div>
          )}
        </>
      )}
    </section>
  );
}
