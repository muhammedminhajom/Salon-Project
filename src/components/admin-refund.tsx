"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";

export function AdminRefund({ bookingId, availablePaise }: { bookingId: string; availablePaise: number }) {
  const router = useRouter();
  const requestKeyRef = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    requestKeyRef.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ refund: { status: string } }>(
        "/api/admin/refunds",
        jsonRequest("POST", {
          bookingId,
          requestKey: requestKeyRef.current,
          amountPaise: Number(values.get("paise")),
          destination: values.get("destination"),
          reason: values.get("reason"),
        }),
      );
      setStatus("Refund " + result.refund.status.toLowerCase() + ".");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Override refund</summary>
      <form
        className="form-stack booking-settings"
        onSubmit={submit}
        onChange={() => {
          requestKeyRef.current = undefined;
        }}
      >
        <p>{money(availablePaise)} collected and not yet refunded.</p>
        <label>
          Amount (paise)
          <input name="paise" type="number" min={1} max={availablePaise} required />
        </label>
        <label>
          Refund to
          <select name="destination">
            <option value="ORIGINAL">Original payment method</option>
            <option value="WALLET">Customer wallet</option>
          </select>
        </label>
        <label>
          Reason
          <textarea name="reason" minLength={10} maxLength={500} required />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
        <Button disabled={busy}>Save refund</Button>
      </form>
    </details>
  );
}
