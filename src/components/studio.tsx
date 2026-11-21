"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Temporal } from "@js-temporal/polyfill";
import type { Studio } from "@/lib/provider";
import { api, jsonRequest } from "@/lib/client";
import { displayDate, money } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type DraftStudio = Studio & { payoutAdded: boolean };
type Category = { id: string; name: string };
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const asText = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const asNumber = (data: FormData, key: string) => Number(asText(data, key));
const paise = (data: FormData, key: string) => Math.round(asNumber(data, key) * 100);
const optional = (data: FormData, key: string) => asText(data, key) || undefined;
const checked = (data: FormData, key: string) => data.has(key);
const list = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

function CommandForm({
  children,
  build,
  label,
  variant = "primary",
  reset = false,
  confirmation,
}: {
  children?: ReactNode;
  build: (form: FormData) => unknown;
  label: string;
  variant?: "primary" | "outline" | "ghost";
  reset?: boolean;
  confirmation?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation && !window.confirm(confirmation)) return;
    const form = event.currentTarget;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/provider", jsonRequest("POST", build(new FormData(form))));
      if (reset) form.reset();
      setNotice("Saved.");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="form-stack">
      {children}
      <div className="action-row">
        <Button type="submit" size="sm" variant={variant} disabled={busy}>
          {busy ? "Saving…" : label}
        </Button>
        {notice && (
          <span className="muted" role="status">
            {notice}
          </span>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Input({
  label,
  name,
  defaultValue,
  type = "text",
  required = false,
  min,
  max,
  step,
  maxLength,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  min?: number | string;
  max?: number;
  step?: number | "any";
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        defaultValue={defaultValue ?? ""}
        type={type}
        required={required}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        placeholder={placeholder}
      />
    </label>
  );
}

function Check({ label, name, defaultChecked }: { label: string; name: string; defaultChecked: boolean }) {
  return (
    <label className="checkbox-label">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} /> {label}
    </label>
  );
}

function Documents({ studio }: { studio: DraftStudio }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canUpload = studio.status === "DRAFT" || studio.status === "REJECTED";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("document");
    if (!(file instanceof File) || !file.size) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api("/api/provider/documents", {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type, "X-File-Name": file.name.replace(/[^a-zA-Z0-9_. -]/g, "_") },
      });
      form.reset();
      setMessage("Document uploaded.");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Business verification</h2>
      {studio.documents.length ? (
        <ul className="mini-list">
          {studio.documents.map(({ id, filename }) => (
            <li key={id}>
              <a href={`/api/provider/documents/${id}`}>{filename}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="studio-info">Add a business or identity document for the admin review.</p>
      )}
      {canUpload && (
        <form className="form-stack" onSubmit={submit}>
          <label>
            Verification document
            <input type="file" name="document" accept="application/pdf,image/jpeg,image/png" required />
            <small>PDF, JPEG, or PNG, up to 3 MB.</small>
          </label>
          <div>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {busy ? "Uploading…" : "Upload document"}
            </Button>
          </div>
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
        </form>
      )}
    </section>
  );
}

export function StudioProfile({ studio }: { studio: DraftStudio }) {
  const artist = studio.type === "ARTIST";
  const editable = studio.status !== "PENDING" && studio.status !== "SUSPENDED";
  return (
    <div className="studio-stack">
      {editable && (
        <section className="panel">
          <h2>{artist ? "Artist profile" : "Salon profile"}</h2>
          <CommandForm
            label="Save profile"
            build={(data) => ({
              action: "profile",
              displayName: asText(data, "displayName"),
              description: asText(data, "description"),
              city: asText(data, "city"),
              area: asText(data, "area"),
              image: asText(data, "image") || null,
              gallery: list(asText(data, "gallery")),
              specialties: list(asText(data, "specialties")),
              homeEnabled: artist || checked(data, "homeEnabled"),
              travelRadiusKm: asNumber(data, "travelRadiusKm"),
              travelBasePaise: paise(data, "travelBasePaise"),
              travelPerKmPaise: paise(data, "travelPerKmPaise"),
              travelMinutesPerKm: asNumber(data, "travelMinutesPerKm"),
              cancelBeforeHours: asNumber(data, "cancelBeforeHours"),
              autoConfirm: checked(data, "autoConfirm"),
              payout: optional(data, "payout"),
            })}
          >
            <div className="two-grid studio-form-grid">
              <Input
                label="Display name"
                name="displayName"
                defaultValue={studio.displayName}
                required
                maxLength={80}
              />
              <Input label="Cover image URL" name="image" defaultValue={studio.image} maxLength={500} />
              <Input label="City" name="city" defaultValue={studio.city} required maxLength={80} />
              <Input label="Neighbourhood" name="area" defaultValue={studio.area} required maxLength={100} />
            </div>
            <label>
              About your business
              <textarea
                name="description"
                defaultValue={studio.description}
                required
                maxLength={1800}
                rows={4}
              />
            </label>
            <div className="two-grid studio-form-grid">
              <label>
                {artist ? "Portfolio image URLs" : "Gallery image URLs"}
                <textarea name="gallery" defaultValue={studio.gallery.join("\n")} rows={3} />
                <small>One link per line.</small>
              </label>
              <label>
                Specialties
                <textarea name="specialties" defaultValue={studio.specialties.join("\n")} rows={3} />
                <small>One specialty per line.</small>
              </label>
            </div>
            {!artist && (
              <Check label="Offer home visits" name="homeEnabled" defaultChecked={studio.homeEnabled} />
            )}
            <div className="two-grid studio-form-grid">
              <Input
                label="Home visit radius (km)"
                name="travelRadiusKm"
                type="number"
                min={1}
                max={100}
                defaultValue={studio.travelRadiusKm}
                required
              />
              <Input
                label="Base travel charge (₹)"
                name="travelBasePaise"
                type="number"
                min={0}
                max={1000}
                step={0.01}
                defaultValue={studio.travelBasePaise / 100}
                required
              />
              <Input
                label="Travel charge per km (₹)"
                name="travelPerKmPaise"
                type="number"
                min={0}
                max={200}
                step={0.01}
                defaultValue={studio.travelPerKmPaise / 100}
                required
              />
              <Input
                label="Travel time per km (min)"
                name="travelMinutesPerKm"
                type="number"
                min={1}
                max={25}
                defaultValue={studio.travelMinutesPerKm}
                required
              />
              <Input
                label="Cancellation notice (hours)"
                name="cancelBeforeHours"
                type="number"
                min={0}
                max={168}
                defaultValue={studio.cancelBeforeHours}
                required
              />
              {studio.status !== "APPROVED" && (
                <Input
                  label={studio.payoutAdded ? "Replace payout UPI ID" : "Payout UPI ID"}
                  name="payout"
                  placeholder="name@upi"
                  maxLength={120}
                />
              )}
            </div>
            <Check
              label="Automatically confirm appointments"
              name="autoConfirm"
              defaultChecked={studio.autoConfirm}
            />
          </CommandForm>
        </section>
      )}
      <Documents studio={studio} />
      {(studio.status === "DRAFT" || studio.status === "REJECTED") && (
        <section className="panel">
          <h2>Submit your listing</h2>
          <p className="studio-info">
            Save your profile and payout ID, upload a verification document, and set up a location, working
            hours, and at least one service.
          </p>
          <CommandForm label="Submit for review" build={() => ({ action: "submit" })} />
        </section>
      )}
    </div>
  );
}

function BranchForm({ action, item }: { action: string; item?: Studio["branches"][number] }) {
  return (
    <CommandForm
      label={item ? "Save location" : `Add ${action}`}
      reset={!item}
      build={(data) => ({
        action: "branch",
        branchId: item?.id,
        name: asText(data, "name"),
        address: asText(data, "address"),
        timeZone: asText(data, "timeZone"),
        latitude: optional(data, "latitude") ? asNumber(data, "latitude") : null,
        longitude: optional(data, "longitude") ? asNumber(data, "longitude") : null,
      })}
    >
      <div className="two-grid studio-form-grid">
        <Input label="Location name" name="name" defaultValue={item?.name} required maxLength={70} />
        <Input
          label="Address or service-area landmark"
          name="address"
          defaultValue={item?.address}
          required
          maxLength={400}
        />
        <Input label="Time zone" name="timeZone" defaultValue={item?.timeZone ?? "Asia/Kolkata"} required />
        <Input
          label="Latitude for home visits"
          name="latitude"
          type="number"
          step="any"
          min={-90}
          max={90}
          defaultValue={item?.latitude}
        />
        <Input
          label="Longitude for home visits"
          name="longitude"
          type="number"
          step="any"
          min={-180}
          max={180}
          defaultValue={item?.longitude}
        />
      </div>
    </CommandForm>
  );
}

function BranchHolidays({ branch }: { branch: Studio["branches"][number] }) {
  return (
    <section className="studio-stack">
      <h3>Holidays and closures</h3>
      <p className="muted">Closes the location for the entire date in its local time zone.</p>
      <CommandForm
        label="Add holiday"
        variant="outline"
        reset
        build={(data) => ({
          action: "add-holiday",
          branchId: branch.id,
          date: asText(data, "date"),
          reason: asText(data, "reason"),
        })}
      >
        <div className="two-grid studio-form-grid">
          <Input label="Holiday date" name="date" type="date" required />
          <Input label="Reason (optional)" name="reason" maxLength={140} />
        </div>
      </CommandForm>
      {branch.holidays.length > 0 && (
        <ul className="mini-list">
          {branch.holidays.map(({ date, reason }) => (
            <li key={date}>
              <span>
                <time dateTime={date}>{date}</time>
                {reason && ` · ${reason}`}
              </span>
              <CommandForm
                label="Remove holiday"
                variant="ghost"
                build={() => ({ action: "remove-holiday", branchId: branch.id, date })}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StaffForm({ studio, item }: { studio: DraftStudio; item?: Studio["staff"][number] }) {
  const artist = studio.type === "ARTIST";
  return (
    <CommandForm
      label={item ? "Save team member" : "Add team member"}
      reset={!item}
      build={(data) => ({
        action: "staff",
        staffId: item?.id,
        branchId: asText(data, "branchId"),
        name: asText(data, "name"),
        title: asText(data, "title"),
        commissionBps: Math.round(asNumber(data, "commission") * 100),
        email: optional(data, "email")?.toLowerCase(),
        password: String(data.get("password") ?? "") || undefined,
      })}
    >
      <div className="two-grid studio-form-grid">
        <Input label="Name" name="name" defaultValue={item?.name} required maxLength={80} />
        <Input label="Professional title" name="title" defaultValue={item?.title} maxLength={75} />
        <label>
          Location
          <select name="branchId" defaultValue={item?.branchId ?? studio.branches[0]?.id}>
            {studio.branches.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {!artist && (
          <Input
            label="Commission (%)"
            name="commission"
            type="number"
            min={0}
            max={100}
            step={0.01}
            defaultValue={(item?.commissionBps ?? 0) / 100}
            required
          />
        )}
        {!artist && !item?.user?.email && (
          <>
            <Input label="Staff login email (optional)" name="email" type="email" maxLength={254} />
            <Input
              label="Staff password (at least 10 characters)"
              name="password"
              type="password"
              maxLength={200}
            />
          </>
        )}
      </div>
      {item?.user?.email && <p className="muted">Staff login · {item.user.email}</p>}
    </CommandForm>
  );
}

type ScheduleRow = {
  key: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  kind: "WORK" | "BREAK";
};
const toMinutes = (value: string) => value.split(":").reduce((hour, part) => hour * 60 + Number(part), 0);
const toClock = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function ScheduleEditor({ person, zone }: { person: Studio["staff"][number]; zone: string }) {
  const [rows, setRows] = useState<ScheduleRow[]>(() =>
    person.windows.map((item) => ({ ...item, key: item.id })),
  );
  const [sequence, setSequence] = useState(0);
  function edit(key: string, patch: Partial<ScheduleRow>) {
    setRows((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }
  const convert = (value: string) =>
    Temporal.PlainDateTime.from(value)
      .toZonedDateTime(zone, { disambiguation: "reject" })
      .toInstant()
      .toString();
  return (
    <div className="studio-stack">
      <CommandForm
        label="Save weekly hours"
        build={() => ({
          action: "schedule",
          staffId: person.id,
          windows: rows.map(({ dayOfWeek, startMinute, endMinute, kind }) => ({
            dayOfWeek,
            startMinute,
            endMinute,
            kind,
          })),
        })}
      >
        <p className="muted">Local time · {zone.replaceAll("_", " ")}</p>
        {rows.map((row) => (
          <div className="schedule-row" key={row.key}>
            <label>
              Day
              <select
                value={row.dayOfWeek}
                onChange={(event) => edit(row.key, { dayOfWeek: Number(event.target.value) })}
              >
                {days.map((day, index) => (
                  <option key={day} value={index + 1}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start
              <input
                type="time"
                value={toClock(row.startMinute)}
                onChange={(event) => {
                  if (event.target.value) edit(row.key, { startMinute: toMinutes(event.target.value) });
                }}
                required
              />
            </label>
            <label>
              End
              <input
                type="time"
                value={toClock(row.endMinute === 1440 ? 0 : row.endMinute)}
                onChange={(event) => {
                  if (event.target.value) edit(row.key, { endMinute: toMinutes(event.target.value) || 1440 });
                }}
                required
              />
            </label>
            <label>
              Type
              <select
                value={row.kind}
                onChange={(event) => edit(row.key, { kind: event.target.value as ScheduleRow["kind"] })}
              >
                <option value="WORK">Working hours</option>
                <option value="BREAK">Break</option>
              </select>
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows((prev) => prev.filter((item) => item.key !== row.key))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="action-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length >= 42}
            onClick={() => {
              setRows((prev) => [
                ...prev,
                { key: `new-${sequence}`, dayOfWeek: 1, startMinute: 600, endMinute: 1080, kind: "WORK" },
              ]);
              setSequence(sequence + 1);
            }}
          >
            Add hours or a break
          </Button>
          {!rows.length && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRows(
                  days.map((_, index) => ({
                    key: `standard-${index}`,
                    dayOfWeek: index + 1,
                    startMinute: 600,
                    endMinute: 1080,
                    kind: "WORK",
                  })),
                );
              }}
            >
              Start with 10 am–6 pm daily
            </Button>
          )}
        </div>
      </CommandForm>
      <CommandForm
        label="Block time"
        variant="outline"
        reset
        build={(data) => ({
          action: "time-off",
          staffId: person.id,
          startsAt: convert(asText(data, "startsAt")),
          endsAt: convert(asText(data, "endsAt")),
          reason: asText(data, "reason"),
        })}
      >
        <div className="two-grid studio-form-grid">
          <Input label="Block starts" name="startsAt" type="datetime-local" required />
          <Input label="Block ends" name="endsAt" type="datetime-local" required />
        </div>
        <Input label="Reason (optional)" name="reason" maxLength={140} />
      </CommandForm>
      {person.timeOff.length > 0 && (
        <ul className="mini-list">
          {person.timeOff.map((block) => (
            <li key={block.id}>
              <span>
                {displayDate(block.startsAt, zone)} to {displayDate(block.endsAt, zone)}{" "}
                {block.reason && `· ${block.reason}`}
              </span>
              <CommandForm
                label="Remove block"
                variant="ghost"
                build={() => ({ action: "remove-time-off", blockId: block.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StudioTeam({ studio }: { studio: DraftStudio }) {
  const artist = studio.type === "ARTIST";
  const location = artist ? "service-area base" : "branch";
  if (studio.status === "PENDING" || studio.status === "SUSPENDED")
    return (
      <div className="empty-state">
        Your location and schedule settings are paused while your listing is under review or suspended.
      </div>
    );
  return (
    <div className="studio-stack">
      <section className="panel">
        <h2>{artist ? "Service-area base" : "Branches"}</h2>
        <div className="studio-stack">
          {studio.branches.map((item) => (
            <details key={item.id} className="studio-disclosure">
              <summary>{item.name}</summary>
              <div className="studio-stack">
                <BranchForm action={location} item={item} />
                <BranchHolidays branch={item} />
                {!artist && (
                  <CommandForm
                    label="Archive branch"
                    variant="ghost"
                    build={() => ({ action: "archive-branch", branchId: item.id })}
                  />
                )}
              </div>
            </details>
          ))}
          {(!artist || !studio.branches.length) && (
            <details className="studio-disclosure" open={!studio.branches.length}>
              <summary>Add {artist ? "your service-area base" : "a branch"}</summary>
              <BranchForm action={location} />
            </details>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>{artist ? "Solo calendar" : "Team and schedules"}</h2>
        {!studio.branches.length && <p className="studio-info">Add a location to configure availability.</p>}
        <div className="studio-stack">
          {studio.staff.map((person) => (
            <details className="studio-disclosure" key={person.id} open={artist}>
              <summary>
                {person.name}
                {person.title && ` · ${person.title}`}
              </summary>
              <div className="studio-stack">
                <StaffForm studio={studio} item={person} />
                <ScheduleEditor
                  person={person}
                  zone={studio.branches.find(({ id }) => id === person.branchId)?.timeZone ?? "Asia/Kolkata"}
                />
                {!artist && (
                  <CommandForm
                    label="Archive team member"
                    variant="ghost"
                    build={() => ({ action: "archive-staff", staffId: person.id })}
                  />
                )}
              </div>
            </details>
          ))}
          {!artist && studio.branches.length > 0 && (
            <details className="studio-disclosure" open={!studio.staff.length}>
              <summary>Add a team member</summary>
              <StaffForm studio={studio} />
            </details>
          )}
        </div>
      </section>
    </div>
  );
}

function ServiceEditor({
  studio,
  categories,
  item,
}: {
  studio: DraftStudio;
  categories: Category[];
  item?: Studio["services"][number];
}) {
  return (
    <CommandForm
      label={item ? "Save service" : "Add service"}
      reset={!item}
      build={(data) => ({
        action: "service",
        serviceId: item?.id,
        categoryId: asText(data, "categoryId"),
        name: asText(data, "name"),
        description: asText(data, "description"),
        kind: asText(data, "kind"),
        duration: asNumber(data, "duration"),
        buffer: asNumber(data, "buffer"),
        pricePaise: paise(data, "pricePaise"),
        listPaise: optional(data, "listPaise") ? paise(data, "listPaise") : null,
        homeEligible: studio.type === "ARTIST" || checked(data, "homeEligible"),
        staffIds: data.getAll("staffIds").map(String),
      })}
    >
      <div className="two-grid studio-form-grid">
        <Input label="Service name" name="name" defaultValue={item?.name} required maxLength={100} />
        <label>
          Category
          <select name="categoryId" defaultValue={item?.categoryId}>
            {categories.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service type
          <select name="kind" defaultValue={item?.kind ?? "SERVICE"}>
            <option value="SERVICE">Service</option>
            <option value="PACKAGE">Package or combo</option>
            <option value="ADD_ON">Add-on</option>
          </select>
        </label>
        <Input
          label="Duration (min)"
          name="duration"
          type="number"
          min={5}
          max={480}
          defaultValue={item?.duration ?? 30}
          required
        />
        <Input
          label="Buffer after service (min)"
          name="buffer"
          type="number"
          min={0}
          max={120}
          defaultValue={item?.buffer ?? 0}
          required
        />
        <Input
          label="Booking price (₹)"
          name="pricePaise"
          type="number"
          min={0}
          max={50000}
          step={0.01}
          defaultValue={item ? item.pricePaise / 100 : undefined}
          required
        />
        <Input
          label="Original price for offers (₹)"
          name="listPaise"
          type="number"
          min={0.01}
          max={50000}
          step={0.01}
          defaultValue={item?.listPaise ? item.listPaise / 100 : undefined}
        />
      </div>
      <label>
        Description
        <textarea name="description" rows={3} maxLength={750} defaultValue={item?.description ?? ""} />
      </label>
      {studio.type === "SHOP" && (
        <Check
          label="Available as a home visit"
          name="homeEligible"
          defaultChecked={item?.homeEligible ?? false}
        />
      )}
      <fieldset>
        <legend>Assigned professionals</legend>
        <div className="studio-checks">
          {studio.staff.map(({ id, name }) => (
            <label className="checkbox-label" key={id}>
              <input
                type="checkbox"
                name="staffIds"
                value={id}
                defaultChecked={
                  item ? item.staff.some(({ staffId }) => staffId === id) : studio.staff.length === 1
                }
              />{" "}
              {name}
            </label>
          ))}
        </div>
      </fieldset>
    </CommandForm>
  );
}

export function StudioServices({ studio, categories }: { studio: DraftStudio; categories: Category[] }) {
  if (studio.status === "PENDING" || studio.status === "SUSPENDED")
    return (
      <div className="empty-state">
        Your service settings are paused while your listing is under review or suspended.
      </div>
    );
  return (
    <section className="panel">
      <h2>Service catalog</h2>
      {!studio.staff.length && (
        <p className="studio-info">Add an active team member before creating services.</p>
      )}
      <div className="studio-stack">
        {studio.services.map((item) => (
          <details className="studio-disclosure" key={item.id}>
            <summary>
              {item.name} · {money(item.pricePaise)} · {item.active ? "Visible" : "Hidden"}
            </summary>
            <div className="studio-stack">
              {studio.staff.length > 0 && (
                <ServiceEditor studio={studio} categories={categories} item={item} />
              )}
              <CommandForm
                label={item.active ? "Hide service" : "Show service"}
                variant="ghost"
                build={() => ({ action: "park-service", serviceId: item.id, active: !item.active })}
              />
              <CommandForm
                label="Delete service"
                variant="ghost"
                confirmation="Delete this service? Services with booking history will be archived."
                build={() => ({ action: "delete-service", serviceId: item.id })}
              />
            </div>
          </details>
        ))}
        {studio.staff.length > 0 && (
          <details className="studio-disclosure" open={!studio.services.length}>
            <summary>Add a service</summary>
            <ServiceEditor studio={studio} categories={categories} />
          </details>
        )}
      </div>
    </section>
  );
}
