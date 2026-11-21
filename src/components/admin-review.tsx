"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

export function AdminReview({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const options =
    status === "PENDING"
      ? [
          ["APPROVED", "Approve"],
          ["REJECTED", "Reject"],
        ]
      : status === "APPROVED"
        ? [["SUSPENDED", "Suspend"]]
        : status === "SUSPENDED"
          ? [["PENDING", "Return to review"]]
          : [];
  const [decision, setDecision] = useState(options[0]?.[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!options.length) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/providers",
        jsonRequest("PATCH", { providerId: id, status: decision, note: form.get("note") || undefined }),
      );
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="two-grid studio-form-grid">
        <label>
          Decision
          <select value={decision} onChange={(event) => setDecision(event.target.value)}>
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Message to provider
          <input name="note" maxLength={500} required={decision === "REJECTED" || decision === "SUSPENDED"} />
        </label>
      </div>
      <div>
        <Button type="submit" disabled={busy} size="sm">
          {busy ? "Saving…" : "Save decision"}
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
