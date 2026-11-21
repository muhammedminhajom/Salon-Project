"use client";

import { useState } from "react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

export function ReviewReportButton({ reviewId }: { reviewId: string }) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function report() {
    const reason = window.prompt("Why should an admin review this comment?");
    if (!reason?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/reviews/${reviewId}/reports`, jsonRequest("POST", { reason }));
      setNotice("Report sent to the moderation team.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void report()}>
        Report
      </Button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
