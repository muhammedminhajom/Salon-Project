"use client";

import { useEffect, useState } from "react";
import { api, jsonRequest } from "@/lib/client";

const events = [
  "BOOKING_CREATED",
  "BOOKING_CONFIRMED",
  "BOOKING_RESCHEDULED",
  "BOOKING_CANCELLED",
  "BOOKING_COMPLETED",
  "BOOKING_NO_SHOW",
  "BOOKING_REMINDER",
  "REVIEW_PROMPT",
  "REVIEW_RECEIVED",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILURE",
  "REFUND_PROCESSED",
  "PAYOUT_PAID",
  "COUPON_OFFER",
] as const;
const channels = ["IN_APP", "EMAIL", "SMS", "WHATSAPP"] as const;
type Preference = { userId?: string; eventType: string; channel: string; enabled: boolean };

export function NotificationPreferences() {
  const [items, setItems] = useState<Preference[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void api<{ preferences: Preference[] }>("/api/notifications/preferences")
      .then((data) => {
        if (active) setItems(data.preferences);
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  function enabled(eventType: string, channel: string) {
    return items.find((item) => item.eventType === eventType && item.channel === channel)?.enabled ?? true;
  }

  async function toggle(eventType: string, channel: string, value: boolean) {
    setError("");
    try {
      await api(
        "/api/notifications/preferences",
        jsonRequest("PUT", { preferences: [{ eventType, channel, enabled: value }] }),
      );
      setItems((current) => {
        const rest = current.filter((item) => item.eventType !== eventType || item.channel !== channel);
        return [...rest, { eventType, channel, enabled: value }];
      });
      setNotice("Notification preferences saved.");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section className="panel studio-stack">
      <h2>Notification preferences</h2>
      <p>Choose which channels can deliver each type of update. In-app messages are on by default.</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <caption className="sr-only">Notification channel preferences</caption>
          <thead>
            <tr>
              <th className="p-2">Event</th>
              {channels.map((channel) => (
                <th className="p-2" key={channel}>
                  {channel.replaceAll("_", " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((eventType) => (
              <tr className="border-t" key={eventType}>
                <th scope="row" className="p-2">
                  {eventType.replaceAll("_", " ")}
                </th>
                {channels.map((channel) => (
                  <td className="p-2" key={channel}>
                    <input
                      type="checkbox"
                      aria-label={`${channel} notifications for ${eventType}`}
                      checked={enabled(eventType, channel)}
                      onChange={(event) => void toggle(eventType, channel, event.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
