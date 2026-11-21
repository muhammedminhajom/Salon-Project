"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

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
type Template = { eventType: string; channel: string; subject: string; body: string; enabled: boolean };
type Delivery = {
  id: string;
  attempt: number;
  status: string;
  errorCode: string | null;
  createdAt: string;
  notification: {
    eventType: string;
    channel: string;
    status: string;
    attempts: number;
    lastError: string | null;
  };
};

export function AdminNotifications() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [eventType, setEventType] = useState<(typeof events)[number]>(events[0]);
  const [channel, setChannel] = useState<(typeof channels)[number]>("EMAIL");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<{ subject: string; body: string }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [templateResult, deliveryResult] = await Promise.all([
      api<{ templates: Template[] }>("/api/admin/notifications/templates"),
      api<{ deliveries: Delivery[] }>("/api/admin/notifications/deliveries"),
    ]);
    setTemplates(templateResult.templates);
    setDeliveries(deliveryResult.deliveries);
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<{ templates: Template[] }>("/api/admin/notifications/templates"),
      api<{ deliveries: Delivery[] }>("/api/admin/notifications/deliveries"),
    ])
      .then(([templateResult, deliveryResult]) => {
        if (!active) return;
        setTemplates(templateResult.templates);
        setDeliveries(deliveryResult.deliveries);
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  const current = templates.find((item) => item.eventType === eventType && item.channel === channel);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = { eventType, channel, subject, body, enabled };
      await api("/api/admin/notifications/templates", jsonRequest("PUT", input));
      setNotice("Template saved.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function showPreview() {
    setError("");
    try {
      const result = await api<{ preview: { subject: string; body: string } }>(
        "/api/admin/notifications/templates",
        jsonRequest("POST", { eventType, channel, subject, body, enabled }),
      );
      setPreview(result.preview);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <div className="studio-stack">
      <section className="panel studio-stack">
        <h2>Message templates</h2>
        <form className="form-stack" onSubmit={save}>
          <div className="two-grid studio-form-grid">
            <label>
              Event
              <select
                value={eventType}
                onChange={(event) => {
                  setEventType(event.target.value as typeof eventType);
                  setPreview(undefined);
                }}
              >
                {events.map((item) => (
                  <option key={item} value={item}>
                    {item.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Channel
              <select
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as typeof channel);
                  setPreview(undefined);
                }}
              >
                {channels.map((item) => (
                  <option key={item} value={item}>
                    {item.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} />
          </label>
          <label>
            Body
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={7}
              maxLength={5000}
              required
            />
          </label>
          <p>
            Template variables: <code>{"{{name}}"}</code>, <code>{"{{providerName}}"}</code>,{" "}
            <code>{"{{appointmentAt}}"}</code>.
          </p>
          <label className="inline-field">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled
          </label>
          <div className="action-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSubject(current?.subject ?? "");
                setBody(current?.body ?? "");
                setEnabled(current?.enabled ?? true);
              }}
            >
              Load saved template
            </Button>
            <Button type="button" variant="outline" onClick={() => void showPreview()}>
              Preview
            </Button>
            <Button disabled={busy}>Save template</Button>
          </div>
        </form>
        {preview && (
          <div className="panel">
            <h3>Preview</h3>
            {preview.subject && <strong>{preview.subject}</strong>}
            <p>{preview.body}</p>
          </div>
        )}
      </section>
      <section className="panel studio-stack">
        <h2>Delivery log</h2>
        {deliveries.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <caption className="sr-only">Notification delivery attempts</caption>
              <thead>
                <tr>
                  <th className="p-2">Time</th>
                  <th className="p-2">Event</th>
                  <th className="p-2">Channel</th>
                  <th className="p-2">Attempt</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Code</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr className="border-t" key={delivery.id}>
                    <td className="p-2">{new Date(delivery.createdAt).toLocaleString("en-IN")}</td>
                    <td className="p-2">{delivery.notification.eventType}</td>
                    <td className="p-2">{delivery.notification.channel}</td>
                    <td className="p-2">{delivery.attempt}</td>
                    <td className="p-2">{delivery.status}</td>
                    <td className="p-2">{delivery.errorCode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No external delivery attempts.</p>
        )}
      </section>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
