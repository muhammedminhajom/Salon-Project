"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { api, jsonRequest } from "@/lib/client";
import { decimalHundredths } from "@/lib/utils";

type Settings = {
  depositBps: number | null;
  gstRegistered: boolean;
  gstin: string | null;
  gstRateBps: number;
};

export function PaymentSettings({ settings }: { settings: Settings }) {
  const [registered, setRegistered] = useState(settings.gstRegistered);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const deposit = values.get("deposit");
    setNotice("");
    setError("");
    setBusy(true);
    try {
      await api(
        "/api/provider/payment-settings",
        jsonRequest("PUT", {
          depositBps: deposit ? decimalHundredths(deposit) : null,
          gstRegistered: registered,
          ...(registered
            ? { gstin: values.get("gstin"), gstRateBps: decimalHundredths(values.get("rate")) }
            : {}),
        }),
      );
      setNotice("Payment settings saved.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel form-stack" onSubmit={save}>
      <h2>Advance payments and GST</h2>
      <label>
        Advance deposit (%)
        <input
          name="deposit"
          type="number"
          min="1"
          max="99"
          step="0.01"
          placeholder="25 (platform default)"
          defaultValue={settings.depositBps === null ? "" : settings.depositBps / 100}
        />
      </label>
      <label className="inline-field">
        <input
          type="checkbox"
          checked={registered}
          onChange={(event) => setRegistered(event.target.checked)}
        />{" "}
        GST registered
      </label>
      {registered && (
        <div className="two-grid">
          <label>
            GSTIN{" "}
            <input name="gstin" maxLength={15} minLength={15} defaultValue={settings.gstin ?? ""} required />
          </label>
          <label>
            GST rate (%){" "}
            <input
              name="rate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              defaultValue={settings.gstRateBps / 100}
              required
            />
          </label>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <Button disabled={busy}>Save payment settings</Button>
    </form>
  );
}
