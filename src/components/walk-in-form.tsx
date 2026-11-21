"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api, ApiError, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";

type WalkInStudio = {
  id: string;
  branches: { id: string; name: string }[];
  staff: { id: string; name: string; branchId: string }[];
  services: {
    id: string;
    name: string;
    active: boolean;
    kind: string;
    pricePaise: number;
    staff: { staffId: string }[];
  }[];
};

export function WalkInForm({ studio }: { studio: WalkInStudio }) {
  const router = useRouter();
  const requestKeyRef = useRef<string | undefined>(undefined);
  const [customerName, setCustomerName] = useState("");
  const [branchId, setBranchId] = useState(studio.branches[0]?.id ?? "");
  const [staffId, setStaffId] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const branchStaff = studio.staff.filter((person) => person.branchId === branchId);
  const services = studio.services.filter(
    (service) =>
      service.active &&
      service.staff.some(({ staffId: id }) => branchStaff.some((person) => person.id === id)),
  );
  const selected = services.filter((service) => serviceIds.includes(service.id));
  const eligible = branchStaff.filter((person) =>
    selected.every((service) => service.staff.some(({ staffId: id }) => id === person.id)),
  );
  const hasBase = selected.some((service) => service.kind !== "ADD_ON");

  function changed() {
    requestKeyRef.current = undefined;
    setError("");
    setMessage("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const name = customerName.trim();
    setBusy(true);
    setError("");
    setMessage("");
    requestKeyRef.current ??= crypto.randomUUID();
    try {
      const { booking } = await api<{ booking: { staff: { name: string } } }>(
        "/api/bookings/walk-in",
        jsonRequest("POST", {
          providerId: studio.id,
          branchId,
          staffId: staffId || undefined,
          serviceIds,
          customerName: name,
          requestKey: requestKeyRef.current,
        }),
      );
      requestKeyRef.current = undefined;
      setCustomerName("");
      setMessage(`Walk-in recorded for ${name} with ${booking.staff.name}.`);
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "SLOT_UNAVAILABLE")
        setError("No selected professional can take this walk-in now.");
      else setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Record a walk-in</h2>
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={busy}>
          <legend className="sr-only">Walk-in details</legend>
          <label>
            Customer name
            <input
              name="customerName"
              maxLength={80}
              required
              value={customerName}
              onChange={(event) => {
                setCustomerName(event.target.value);
                changed();
              }}
            />
          </label>
          <label>
            Branch
            <select
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
                setServiceIds([]);
                setStaffId("");
                changed();
              }}
            >
              {studio.branches.map((branch) => (
                <option value={branch.id} key={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          {services.length === 0 && <p>No active services are assigned to this branch.</p>}
          {services.length > 0 && (
            <fieldset className="form-stack">
              <legend>Services</legend>
              {services.map((service) => {
                const checked = serviceIds.includes(service.id);
                return (
                  <label className="checkbox-label" key={service.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && serviceIds.length >= 8}
                      onChange={() => {
                        setServiceIds((ids) =>
                          checked ? ids.filter((id) => id !== service.id) : [...ids, service.id],
                        );
                        setStaffId("");
                        changed();
                      }}
                    />
                    {service.name} · {money(service.pricePaise)}
                  </label>
                );
              })}
            </fieldset>
          )}
          <label>
            Professional
            <select
              value={staffId}
              onChange={(event) => {
                setStaffId(event.target.value);
                changed();
              }}
            >
              <option value="">Any available professional</option>
              {eligible.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          {selected.length > 0 && !hasBase && (
            <p className="muted">Select a service or package to book with an add-on.</p>
          )}
          {hasBase && !eligible.length && (
            <p className="muted">No professional is assigned to all selected services.</p>
          )}
          <Button type="submit" disabled={!branchId || !hasBase || !eligible.length || busy}>
            {busy ? "Recording…" : "Start walk-in now"}
          </Button>
        </fieldset>
        {message && (
          <p role="status" className="form-success">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
