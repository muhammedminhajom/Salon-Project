"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { CancellationPolicy as Policy } from "@/lib/cancellation";
import { api, jsonRequest } from "@/lib/client";
import { decimalHundredths } from "@/lib/utils";

export function CancellationPolicy({ policy }: { policy: Policy }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api(
        "/api/provider",
        jsonRequest("POST", {
          action: "cancellation-policy",
          freeRefundHours: Number(form.get("free")),
          noRefundHours: Number(form.get("cutoff")),
          cancellationFeeBps: decimalHundredths(form.get("fee")),
          noShowFeeBps: decimalHundredths(form.get("noShow")),
        }),
      );
      setMessage("Cancellation policy saved for new appointments.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel form-stack" onSubmit={save}>
      <h2>Cancellation policy</h2>
      <label>
        Free cancellation, hours before start
        <input
          name="free"
          type="number"
          min={0}
          max={168}
          defaultValue={policy.freeRefundHours ?? policy.cancelBeforeHours}
          required
        />
      </label>
      <label>
        No refund within this many hours
        <input name="cutoff" type="number" min={0} max={168} defaultValue={policy.noRefundHours} required />
      </label>
      <label>
        Late cancellation fee (%)
        <input
          name="fee"
          type="number"
          min={0}
          max={100}
          step="0.01"
          defaultValue={policy.cancellationFeeBps / 100}
          required
        />
      </label>
      <label>
        No-show fee (%)
        <input
          name="noShow"
          type="number"
          min={0}
          max={100}
          step="0.01"
          defaultValue={policy.noShowFeeBps / 100}
          required
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <Button disabled={busy}>Save cancellation policy</Button>
    </form>
  );
}
