"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { CalendarDays, Check, Clock3, House, MapPin, Store } from "lucide-react";
import type { PaymentMode, Role } from "@prisma/client";
import { CheckoutPayment } from "@/components/checkout-payment";
import type { MarketProfile } from "@/lib/catalog";
import { ApiError, api, jsonRequest } from "@/lib/client";
import type { priceCheckout } from "@/lib/money";
import { displayDate, displayTime, money } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Slots = {
  timeZone: string;
  duration: number;
  travelPaise: number;
  totalPaise: number;
  slots: { startsAt: string; staffCount: number }[];
};
type Confirmation = {
  id: string;
  status: string;
  startsAt: string;
  timeZone: string;
  staff: { name: string };
  totalPaise: number;
  holdExpiresAt: string | null;
  payment: { dueAtVenuePaise: number; gatewayAmountPaise: number } | null;
};
type Quote = ReturnType<typeof priceCheckout> & {
  balancePaise: number;
  couponDiscountPaise: number;
  couponFunding: string | null;
  loyaltyPointsAvailable: number;
  loyaltyDiscountPaise: number;
};
type PaymentSelection = {
  paymentMode: PaymentMode;
  useWallet: boolean;
  couponCode?: string;
  loyaltyPoints?: number;
};
type Draft = {
  serviceIds: string[];
  branchId: string;
  staffId: string;
  mode: "HOME" | "VENUE";
  date: string;
};

const emptyDraft = () => null;
const subscribeToDraft = () => () => {};

function captureDraft(key: string) {
  let value: string | null | undefined;
  return () => {
    if (value === undefined) {
      try {
        value = sessionStorage.getItem(key);
      } catch {
        value = null;
      }
    }
    return value;
  };
}

function restoreDraft(saved: string | null, profile: MarketProfile) {
  if (!saved) return;
  try {
    const previous: Draft = JSON.parse(saved);
    if (
      profile.branches.some(({ id }) => id === previous.branchId) &&
      previous.serviceIds.every((id) => profile.services.some((service) => service.id === id))
    ) {
      return previous;
    }
  } catch {
    // An invalid saved draft is discarded.
  }
}

export function BookingForm({
  profile,
  viewerRole,
  onlineEnabled,
  initialServices,
  dateLimits,
}: {
  profile: MarketProfile;
  viewerRole?: Role;
  onlineEnabled: boolean;
  initialServices: string[];
  dateLimits: Record<string, { today: string; max: string }>;
}) {
  const router = useRouter();
  const initialBranch = profile.branches[0]?.id ?? "";
  const [editedDraft, setEditedDraft] = useState<Draft>();
  const [editedStep, setEditedStep] = useState<number>();
  const initialDraft: Draft = {
    serviceIds: profile.services
      .filter((service) => initialServices.includes(service.id))
      .map(({ id }) => id),
    mode: profile.type === "ARTIST" ? "HOME" : "VENUE",
    branchId: initialBranch,
    staffId: "",
    date: dateLimits[initialBranch]?.today ?? "",
  };
  const [location, setLocation] = useState({ address: "", latitude: "", longitude: "" });
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");
  const [slots, setSlots] = useState<Slots>();
  const [chosen, setChosen] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [checkout, setCheckout] = useState<PaymentSelection>({
    paymentMode: "PAY_AT_VENUE",
    useWallet: false,
  });
  const [quote, setQuote] = useState<Quote>();
  const [couponCode, setCouponCode] = useState("");
  const [loyaltyPointsInput, setLoyaltyPointsInput] = useState("0");
  const draftKey = `bloom:booking:${profile.id}`;
  const pathname = `/providers/${profile.slug}`;

  const getDraft = useMemo(
    () => (viewerRole === "CUSTOMER" ? captureDraft(draftKey) : emptyDraft),
    [draftKey, viewerRole],
  );
  const saved = useSyncExternalStore(subscribeToDraft, getDraft, emptyDraft);
  const restored = restoreDraft(saved, profile);
  const draft = editedDraft ?? restored ?? initialDraft;
  const step = editedStep ?? (restored ? 2 : 1);

  useEffect(() => {
    if (!saved) return;
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      // Browsers may disable session storage.
    }
  }, [draftKey, saved]);

  const selected = draft.serviceIds.flatMap((id) => profile.services.filter((service) => service.id === id));
  const total = selected.reduce((sum, service) => sum + service.pricePaise, 0);
  const team = profile.staff.filter(
    (person) =>
      person.branchId === draft.branchId &&
      selected.every((service) => service.staff.some(({ staffId }) => staffId === person.id)),
  );
  const homeAllowed = profile.homeEnabled && selected.every((service) => service.homeEligible);
  const hasBase = selected.some((service) => service.kind !== "ADD_ON");

  function resetTimes() {
    setChosen("");
    setSlots(undefined);
    setQuote(undefined);
    setRequestKey("");
    setError("");
  }

  async function getQuote(payment: PaymentSelection) {
    const response = await api<{ quote: Quote }>(
      "/api/payments",
      jsonRequest("POST", {
        action: "quote",
        selection: { ...choice(), ...payment },
      }),
    );
    return response.quote;
  }

  async function changePayment(next: PaymentSelection) {
    setBusy(true);
    setError("");
    try {
      setQuote(await getQuote(next));
      setCheckout(next);
      setRequestKey("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applyDiscounts() {
    void changePayment({
      ...checkout,
      couponCode: couponCode.trim() ? couponCode.trim().toUpperCase() : undefined,
      loyaltyPoints: Number(loyaltyPointsInput || 0),
    });
  }

  function change(updates: Partial<Draft>) {
    resetTimes();
    setEditedDraft((old) => ({ ...(old ?? draft), ...updates }));
  }

  function choice() {
    const { branchId, serviceIds, mode, staffId } = draft;
    if (
      draft.mode === "HOME" &&
      (!location.address.trim() || !location.latitude.trim() || !location.longitude.trim())
    ) {
      throw new Error("Enter the home address and its location to check appointment times.");
    }
    return {
      providerId: profile.id,
      branchId,
      serviceIds,
      mode,
      staffId: staffId || undefined,
      ...(draft.mode === "HOME"
        ? {
            location: {
              address: location.address.trim(),
              latitude: Number(location.latitude),
              longitude: Number(location.longitude),
            },
          }
        : {}),
    };
  }

  async function loadSlots(event?: FormEvent) {
    event?.preventDefault();
    resetTimes();
    setBusy(true);
    try {
      const [nextSlots, nextQuote] = await Promise.all([
        api<Slots>("/api/availability", jsonRequest("POST", { ...choice(), date: draft.date })),
        viewerRole === "CUSTOMER" ? getQuote(checkout) : undefined,
      ]);
      setSlots(nextSlots);
      setQuote(nextQuote);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function book() {
    if (!viewerRole) {
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(draft));
      } catch {
        // Sign-in still works when the browser cannot save a draft.
      }
      router.push(`/account?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setBusy(true);
    setError("");
    const key = requestKey || crypto.randomUUID();
    setRequestKey(key);
    try {
      const response = await api<{ booking: Confirmation }>(
        "/api/bookings",
        jsonRequest("POST", {
          ...choice(),
          ...checkout,
          startsAt: chosen,
          requestKey: key,
          expectedTotalPaise: quote?.totalPaise ?? slots?.totalPaise,
          expectedWalletPaise: quote?.walletUsedPaise,
        }),
      );
      setConfirmation(response.booking);
    } catch (cause) {
      if (cause instanceof ApiError && ["SLOT_UNAVAILABLE", "PRICE_CHANGED"].includes(cause.code ?? "")) {
        await loadSlots();
      }
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function locateCustomer() {
    if (!navigator.geolocation) {
      setError("Location access is unavailable. Enter the coordinates manually.");
      return;
    }
    setLocating(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        resetTimes();
        setLocation((value) => ({
          ...value,
          latitude: coords.latitude.toFixed(6),
          longitude: coords.longitude.toFixed(6),
        }));
        setLocating(false);
      },
      () => {
        setError("Location access was unavailable. Enter the coordinates for the address.");
        setLocating(false);
      },
      { timeout: 8000, maximumAge: 0 },
    );
  }

  if (confirmation?.holdExpiresAt && confirmation.payment)
    return (
      <section className="panel booking-box">
        <h2>Finish payment</h2>
        <p>Your time is held until {displayTime(confirmation.holdExpiresAt, confirmation.timeZone)}.</p>
        <CheckoutPayment
          bookingId={confirmation.id}
          amount={confirmation.payment.gatewayAmountPaise}
          onResult={({ status, bookingStatus }) => {
            if (status !== "PENDING")
              setConfirmation({ ...confirmation, status: bookingStatus, holdExpiresAt: null });
          }}
        />
        <Link className="back-link" href="/appointments">
          Manage this hold in My appointments
        </Link>
      </section>
    );
  if (confirmation)
    return (
      <section className="panel booking-box">
        <span className="confirmation-icon">
          <Check size={29} />
        </span>
        <h2>
          {confirmation.status === "CANCELLED"
            ? "Payment hold ended"
            : confirmation.status === "PENDING"
              ? "Appointment requested"
              : "You’re booked!"}
        </h2>
        <p>
          {profile.displayName} · {confirmation.staff.name}
        </p>
        <p>{displayDate(confirmation.startsAt, confirmation.timeZone)}</p>
        {confirmation.status === "CANCELLED" ? (
          <p>Check My appointments for your refund status.</p>
        ) : (
          <p>
            <strong>{money(confirmation.payment?.dueAtVenuePaise ?? confirmation.totalPaise)}</strong> due at
            the appointment
          </p>
        )}
        <Button asChild>
          <Link href="/appointments">View my appointments</Link>
        </Button>
      </section>
    );

  if (!profile.services.length || !profile.branches.length)
    return (
      <div className="panel booking-box">
        <h2>Online booking unavailable</h2>
        <p>Check back for available services and opening times.</p>
      </div>
    );

  return (
    <section className="panel booking-box" aria-labelledby="book-heading">
      <h2 id="book-heading">Book an appointment</h2>
      <div className="booking-steps" aria-label="Booking steps">
        <span aria-current={step === 1 ? "step" : undefined}>Services</span>
        <span aria-current={step === 2 ? "step" : undefined}>Date &amp; time</span>
      </div>
      {step === 1 ? (
        <>
          <fieldset className="service-menu">
            <legend className="sr-only">Select services</legend>
            {profile.services.map((service) => {
              const checked = draft.serviceIds.includes(service.id);
              return (
                <label className="service-option" key={service.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && draft.serviceIds.length >= 8}
                    onChange={() =>
                      change({
                        serviceIds: checked
                          ? draft.serviceIds.filter((id) => id !== service.id)
                          : [...draft.serviceIds, service.id],
                        staffId: "",
                      })
                    }
                  />
                  <span>
                    <strong>{service.name}</strong>
                    <small>
                      <Clock3 size={13} /> {service.duration} min{" "}
                      {service.kind === "ADD_ON" ? "· Add-on" : service.kind === "PACKAGE" ? "· Package" : ""}
                    </small>
                    {service.description && <small>{service.description}</small>}
                  </span>
                  <span className="service-price">
                    {service.listPaise && <del>{money(service.listPaise)}</del>}
                    <strong>{money(service.pricePaise)}</strong>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="booking-total">
            <span>Service total</span>
            <strong>{money(total)}</strong>
          </div>
          {selected.length > 0 && !hasBase && (
            <p className="muted">Select a service or package to book with an add-on.</p>
          )}
          <Button
            className="full-width"
            type="button"
            disabled={!hasBase}
            onClick={() => {
              if (profile.type === "SHOP" && !homeAllowed && draft.mode === "HOME") change({ mode: "VENUE" });
              setEditedStep(2);
            }}
          >
            Continue
          </Button>
        </>
      ) : (
        <>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              resetTimes();
              setEditedStep(1);
            }}
          >
            Edit services
          </button>
          <form className="form-stack booking-settings" onSubmit={loadSlots}>
            <fieldset disabled={busy} className="form-stack">
              <legend className="sr-only">Appointment details</legend>
              {profile.type === "SHOP" && (
                <label>
                  Branch
                  <select
                    value={draft.branchId}
                    onChange={(event) => {
                      const branchId = event.target.value;
                      change({ branchId, staffId: "", date: dateLimits[branchId].today });
                    }}
                  >
                    {profile.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {profile.type === "SHOP" && (
                <label>
                  Professional
                  <select value={draft.staffId} onChange={(event) => change({ staffId: event.target.value })}>
                    <option value="">Any available professional</option>
                    {team.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="segmented" aria-label="Appointment location">
                {profile.type === "SHOP" && (
                  <button
                    type="button"
                    aria-pressed={draft.mode === "VENUE"}
                    onClick={() => change({ mode: "VENUE" })}
                  >
                    <Store size={17} /> In salon
                  </button>
                )}
                {homeAllowed && (
                  <button
                    type="button"
                    aria-pressed={draft.mode === "HOME"}
                    onClick={() => change({ mode: "HOME" })}
                  >
                    <House size={17} /> At home
                  </button>
                )}
              </div>
              {draft.mode === "HOME" && (
                <>
                  <label>
                    Home-visit address
                    <input
                      value={location.address}
                      maxLength={500}
                      onChange={(event) => {
                        resetTimes();
                        setLocation({ ...location, address: event.target.value });
                      }}
                      required
                    />
                  </label>
                  <Button variant="outline" type="button" onClick={locateCustomer} disabled={locating}>
                    <MapPin size={16} /> {locating ? "Locating…" : "Use my current location"}
                  </Button>
                  <div className="two-grid compact-grid">
                    {(["latitude", "longitude"] as const).map((coordinate) => (
                      <label key={coordinate}>
                        {coordinate === "latitude" ? "Latitude" : "Longitude"}
                        <input
                          type="number"
                          step="any"
                          min={coordinate === "latitude" ? -90 : -180}
                          max={coordinate === "latitude" ? 90 : 180}
                          value={location[coordinate]}
                          onChange={(event) => {
                            resetTimes();
                            setLocation({ ...location, [coordinate]: event.target.value });
                          }}
                          required
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}
              <label>
                Date
                <input
                  type="date"
                  required
                  value={draft.date}
                  min={dateLimits[draft.branchId]?.today}
                  max={dateLimits[draft.branchId]?.max}
                  onChange={(event) => change({ date: event.target.value })}
                />
              </label>
              <Button type="submit" variant="outline" disabled={locating}>
                <CalendarDays size={17} /> {busy ? "Please wait…" : "Check availability"}
              </Button>
            </fieldset>
          </form>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {slots && (
            <>
              <p className="muted slot-summary">
                {slots.duration} min · {slots.timeZone.replaceAll("_", " ")}
              </p>
              <div className="slot-grid">
                {slots.slots.map(({ startsAt }) => (
                  <button
                    type="button"
                    disabled={busy}
                    className="slot-button"
                    aria-pressed={chosen === startsAt}
                    key={startsAt}
                    onClick={() => {
                      setChosen(startsAt);
                      setRequestKey("");
                      setError("");
                    }}
                  >
                    {displayTime(startsAt, slots.timeZone)}
                  </button>
                ))}
              </div>
              {!slots.slots.length && (
                <p role="status">No times available. Try another date or professional.</p>
              )}
              {quote && (
                <fieldset disabled={busy} className="form-stack booking-settings">
                  <legend>Checkout</legend>
                  <label>
                    Payment method
                    <select
                      value={checkout.paymentMode}
                      onChange={(event) =>
                        void changePayment({
                          ...checkout,
                          paymentMode: event.target.value as PaymentMode,
                        })
                      }
                    >
                      <option value="PAY_AT_VENUE">Pay at the appointment</option>
                      {onlineEnabled && <option value="FULL_ONLINE">Pay in full online</option>}
                      {onlineEnabled && <option value="DEPOSIT">Pay an advance deposit</option>}
                    </select>
                  </label>
                  {quote.balancePaise > 0 && (
                    <label className="inline-field">
                      <input
                        type="checkbox"
                        checked={checkout.useWallet}
                        onChange={(event) =>
                          void changePayment({ ...checkout, useWallet: event.target.checked })
                        }
                      />
                      Use wallet · {money(quote.balancePaise)} available
                    </label>
                  )}
                  <div className="inline-form">
                    <label>
                      Coupon code
                      <input
                        value={couponCode}
                        onChange={(event) => setCouponCode(event.target.value.toUpperCase())}
                        maxLength={40}
                      />
                    </label>
                    <label>
                      Loyalty points ({quote.loyaltyPointsAvailable} available)
                      <input
                        type="number"
                        min="0"
                        max={quote.loyaltyPointsAvailable}
                        step="1"
                        value={loyaltyPointsInput}
                        onChange={(event) => setLoyaltyPointsInput(event.target.value)}
                      />
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={applyDiscounts}
                    >
                      Apply offers
                    </Button>
                  </div>
                  <dl>
                    <div className="booking-total">
                      <dt>Services</dt>
                      <dd>{money(quote.servicePaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Home visit</dt>
                      <dd>{money(quote.travelPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Discount</dt>
                      <dd>{money(quote.discountPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>GST</dt>
                      <dd>{money(quote.taxPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Total</dt>
                      <dd>{money(quote.totalPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Wallet applied</dt>
                      <dd>{money(quote.walletUsedPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Due online</dt>
                      <dd>{money(quote.gatewayAmountPaise)}</dd>
                    </div>
                    <div className="booking-total">
                      <dt>Due at the appointment</dt>
                      <dd>{money(quote.dueAtVenuePaise)}</dd>
                    </div>
                  </dl>
                </fieldset>
              )}
              {!quote && slots.travelPaise > 0 && (
                <div className="booking-total">
                  <span>Home-visit charge</span>
                  <span>{money(slots.travelPaise)}</span>
                </div>
              )}
              {!quote && (
                <div className="booking-total">
                  <span>Due at the appointment</span>
                  <strong>{money(slots.totalPaise)}</strong>
                </div>
              )}
              {viewerRole && viewerRole !== "CUSTOMER" ? (
                <p className="muted">Sign in with a customer account to book.</p>
              ) : (
                <Button type="button" className="full-width" disabled={!chosen || busy} onClick={book}>
                  {busy
                    ? "Booking…"
                    : !viewerRole
                      ? "Sign in to book"
                      : quote?.gatewayAmountPaise
                        ? "Continue to payment"
                        : profile.autoConfirm
                          ? "Confirm appointment"
                          : "Request appointment"}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
