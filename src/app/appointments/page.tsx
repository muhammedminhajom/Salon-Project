import type { Metadata } from "next";
import { Appointments } from "@/components/appointments";
import { NotificationCenter } from "@/components/notification-center";
import { NotificationPreferences } from "@/components/notification-preferences";
import { pageUser } from "@/lib/auth";
import { listBookings } from "@/lib/bookings";
import { requestTime } from "@/lib/request-time";

export const metadata: Metadata = { title: "My appointments" };

export default async function AppointmentsPage() {
  const user = await pageUser("/appointments", "CUSTOMER");
  const items = await listBookings(user);
  return (
    <section className="wrap page-space dashboard">
      <div className="section-head">
        <h1>My appointments</h1>
        <p>View your bookings, change a time, or book again.</p>
      </div>
      <NotificationCenter />
      <NotificationPreferences />
      <Appointments items={items} role={user.role} now={requestTime()} />
    </section>
  );
}
