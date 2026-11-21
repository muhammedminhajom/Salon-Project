"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RefundDestination, Role } from "@prisma/client";
import { AdminRefund } from "@/components/admin-refund";
import { CheckoutPayment } from "@/components/checkout-payment";
import { api, jsonRequest } from "@/lib/client";
import { bookingLabel, displayDate, displayTime, money } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CustomerReviewForm } from "@/components/customer-review-form";

export type Appointment = {
  id: string;
  status: string;
  startsAt: Date | string;
  timeZone: string;
  mode: string;
  address: string | null;
  totalPaise: number;
  holdExpiresAt: Date | string | null;
  payment: {
    dueAtVenuePaise: number;
    gatewayAmountPaise: number;
    refundedPaise: number;
    walletUsedPaise: number;
    gatewayCapturedPaise: number;
  } | null;
  cancelBeforeHours: number;
  provider: { displayName: string; slug: string };
  branch: { name: string; address: string };
  staff: { name: string };
  customer: { user: { name: string } };
  items: { serviceId: string; name: string }[];
  invoices: { id: string; invoiceNumber: string; kind: string; issuedAt: Date | string }[];
  review: { id: string; rating: number; body: string; editUntil: Date | string; status: string } | null;
};

type CancellationPreview = {
  feePaise: number;
  retainedPaise: number;
  refundPaise: number;
  originalAvailable: boolean;
};
type NewPrice = { differencePaise: number; totalPaise: number; refundPaise: number; dueAtVenuePaise: number };

function AppointmentCard({ item, role, now }: { item: Appointment; role: Role; now: number }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"cancel" | "move">();
  const [times, setTimes] = useState<string[]>();
  const [chosen, setChosen] = useState("");
  const [preview, setPreview] = useState<CancellationPreview>();
  const [price, setPrice] = useState<NewPrice>();
  const [destination, setDestination] = useState<RefundDestination>("ORIGINAL");
  const requestKeyRef = useRef<string | undefined>(undefined);
  const customer = role === "CUSTOMER";
  const start = +new Date(item.startsAt);
  const pending = item.status === "PENDING";
  const confirmed = item.status === "CONFIRMED";
  const hold = item.holdExpiresAt;
  const cancelable = (pending || confirmed) && (!customer || Boolean(hold) || start > now);
  const refundable =
    (item.payment?.gatewayCapturedPaise ?? 0) +
    (item.payment?.walletUsedPaise ?? 0) -
    (item.payment?.refundedPaise ?? 0);
  const changeable =
    (pending || confirmed) && (!customer || start - now >= Math.max(1, item.cancelBeforeHours * 3_600_000));
  const today = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone: item.timeZone }).format(
    new Date(now),
  );

  async function update(method: string, data: unknown, path = "") {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api(`/api/bookings/${item.id}${path}`, jsonRequest(method, data));
      setDialog(undefined);
      setMessage(method === "PUT" ? "Appointment rescheduled." : "Appointment updated.");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    if (dialog === "cancel") {
      setDialog(undefined);
      return;
    }
    setBusy(true);
    setError("");
    requestKeyRef.current = undefined;
    try {
      const result = await api<{ preview: CancellationPreview }>(`/api/bookings/${item.id}/cancel`);
      setPreview(result.preview);
      setDestination(result.preview.originalAvailable ? "ORIGINAL" : "WALLET");
      setDialog("cancel");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const date = String(new FormData(event.currentTarget).get("date"));
    setChosen("");
    setTimes(undefined);
    setPrice(undefined);
    requestKeyRef.current = undefined;
    setError("");
    setBusy(true);
    try {
      const result = await api<{ slots: string[]; price: NewPrice }>(
        `/api/bookings/${item.id}?date=${encodeURIComponent(date)}`,
      );
      setTimes(result.slots);
      setPrice(result.price);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel appointment-card">
      <div className="dash-heading">
        <h3>
          {customer ? (
            <Link href={`/providers/${item.provider.slug}`}>{item.provider.displayName}</Link>
          ) : (
            item.customer.user.name
          )}
        </h3>
        <span className="status" data-status={item.status}>
          {hold ? "Awaiting payment" : (bookingLabel[item.status] ?? item.status)}
        </span>
      </div>
      <p>
        <strong>{item.items.map(({ name }) => name).join(" · ")}</strong>
      </p>
      <p>
        {displayDate(item.startsAt, item.timeZone)} · {item.staff.name}
      </p>
      <p>
        {item.mode === "HOME"
          ? `Home visit · ${item.address}`
          : `${item.branch.name} · ${item.branch.address}`}
      </p>
      <p>
        {money(confirmed || pending ? (item.payment?.dueAtVenuePaise ?? item.totalPaise) : item.totalPaise)}{" "}
        {confirmed || pending ? "due at the appointment" : ""}
      </p>
      {!!item.payment?.refundedPaise && <p>Refunded {money(item.payment.refundedPaise)}</p>}
      {item.invoices.length > 0 && (
        <div className="action-row" aria-label="Booking invoices">
          {item.invoices.map((invoice) => (
            <Link className="back-link" href={`/api/invoices/${invoice.id}`} key={invoice.id}>
              Download{" "}
              {invoice.kind === "CREDIT_NOTE"
                ? "credit note"
                : invoice.kind === "PLATFORM_COMMISSION"
                  ? "commission invoice"
                  : "invoice"}{" "}
              {invoice.invoiceNumber}
            </Link>
          ))}
        </div>
      )}
      {customer &&
        hold &&
        item.payment &&
        (+new Date(hold) > now ? (
          <CheckoutPayment bookingId={item.id} amount={item.payment.gatewayAmountPaise} />
        ) : (
          <p>The payment hold has ended.</p>
        ))}
      <div className="action-row">
        {cancelable && (
          <>
            {changeable && !hold && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDialog(dialog === "move" ? undefined : "move");
                  setTimes(undefined);
                  setChosen("");
                  setError("");
                }}
              >
                Reschedule
              </Button>
            )}
            <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={loadPreview}>
              {pending && !customer ? "Decline" : "Cancel appointment"}
            </Button>
          </>
        )}
        {customer && !pending && !confirmed && item.status !== "IN_PROGRESS" && (
          <Button variant="outline" size="sm" asChild>
            <Link
              href={`/providers/${item.provider.slug}?services=${encodeURIComponent(item.items.map(({ serviceId }) => serviceId).join(","))}`}
            >
              Book again
            </Link>
          </Button>
        )}
        {!customer && pending && !hold && start > now && (
          <Button size="sm" disabled={busy} onClick={() => update("PATCH", { status: "CONFIRMED" })}>
            Accept
          </Button>
        )}
        {!customer && confirmed && start <= now && (
          <>
            <Button size="sm" disabled={busy} onClick={() => update("PATCH", { status: "IN_PROGRESS" })}>
              Start appointment
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => update("PATCH", { status: "NO_SHOW" })}
            >
              Mark no-show
            </Button>
          </>
        )}
        {!customer && item.status === "IN_PROGRESS" && (
          <Button size="sm" disabled={busy} onClick={() => update("PATCH", { status: "COMPLETED" })}>
            Mark completed
          </Button>
        )}
      </div>
      {role === "ADMIN" && !hold && refundable > 0 && (
        <AdminRefund bookingId={item.id} availablePaise={refundable} />
      )}
      {customer && item.status === "COMPLETED" && (
        <CustomerReviewForm bookingId={item.id} current={item.review} now={now} />
      )}
      {dialog === "cancel" && preview && (
        <div className="form-stack booking-settings">
          <p>
            Refund {money(preview.refundPaise)}. Fee retained {money(preview.retainedPaise)}.
          </p>
          {!!preview.refundPaise && customer && preview.originalAvailable && (
            <label>
              Refund to{" "}
              <select
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value as RefundDestination);
                  requestKeyRef.current = undefined;
                }}
              >
                <option value="ORIGINAL">Original payment method</option>
                <option value="WALLET">Wallet</option>
              </select>
            </label>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              requestKeyRef.current ??= crypto.randomUUID();
              void update(
                "POST",
                { requestKey: requestKeyRef.current, destination, expectedRefundPaise: preview.refundPaise },
                "/cancel",
              );
            }}
          >
            Yes, cancel
          </Button>
        </div>
      )}
      {dialog === "move" && (
        <div className="form-stack booking-settings">
          <form className="action-row" onSubmit={load}>
            <label>
              New date
              <input
                type="date"
                name="date"
                min={/^\d{4}-/.test(today) ? today : undefined}
                required
                onChange={() => {
                  setTimes(undefined);
                  setChosen("");
                }}
              />
            </label>
            <Button type="submit" variant="outline" disabled={busy}>
              Check available times
            </Button>
          </form>
          {times &&
            (times.length ? (
              <>
                <div className="slot-grid">
                  {times.map((time) => (
                    <button
                      className="slot-button"
                      type="button"
                      disabled={busy}
                      key={time}
                      aria-pressed={time === chosen}
                      onClick={() => {
                        setChosen(time);
                        requestKeyRef.current = undefined;
                      }}
                    >
                      {displayTime(time, item.timeZone)}
                    </button>
                  ))}
                </div>
                {price && (
                  <p>
                    New total {money(price.totalPaise)} · Due at the appointment{" "}
                    {money(price.dueAtVenuePaise)}.
                    {price.refundPaise > 0 && " Wallet refund " + money(price.refundPaise) + "."}
                  </p>
                )}
                <Button
                  type="button"
                  disabled={!chosen || !price || busy}
                  onClick={() => {
                    requestKeyRef.current ??= crypto.randomUUID();
                    void update("PUT", {
                      startsAt: chosen,
                      requestKey: requestKeyRef.current,
                      expectedTotalPaise: price?.totalPaise,
                    });
                  }}
                >
                  Save new time
                </Button>
              </>
            ) : (
              <p>No available times on that date.</p>
            ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="form-success" role="status">
          {message}
        </p>
      )}
    </article>
  );
}

export function Appointments({ items, role, now }: { items: Appointment[]; role: Role; now: number }) {
  const active = items.filter(
    (item) =>
      item.status === "IN_PROGRESS" ||
      (["PENDING", "CONFIRMED"].includes(item.status) && +new Date(item.startsAt) >= now),
  );
  const activeIds = new Set(active.map(({ id }) => id));
  const history = items.filter(({ id }) => !activeIds.has(id)).reverse();
  return (
    <>
      <h2>Upcoming</h2>
      {active.length ? (
        <div className="booking-list">
          {active.map((item) => (
            <AppointmentCard item={item} key={item.id} role={role} now={now} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p>No upcoming appointments.</p>
          {role === "CUSTOMER" && (
            <Button asChild variant="outline">
              <Link href="/explore">Explore appointments</Link>
            </Button>
          )}
        </div>
      )}
      <h2>Past appointments</h2>
      {history.length ? (
        <div className="booking-list">
          {history.map((item) => (
            <AppointmentCard item={item} key={item.id} role={role} now={now} />
          ))}
        </div>
      ) : (
        <div className="empty-state">No past appointments.</div>
      )}
    </>
  );
}
