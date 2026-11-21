"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";

export function CustomerReviewForm({
  bookingId,
  current,
  now,
}: {
  bookingId: string;
  current: { rating: number; body: string; editUntil: Date | string } | null;
  now: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const canEdit = !current || +new Date(current.editUntil) > now;
  if (!canEdit)
    return <p className="muted">Review submitted: {current.rating} / 5. The edit period has ended.</p>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("bookingId", bookingId);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/reviews", { method: "POST", body: form });
      setNotice(current ? "Review updated." : "Thanks for sharing your experience.");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="booking-settings" open={Boolean(current)}>
      <summary>{current ? "Edit your review" : "Review this appointment"}</summary>
      <form className="form-stack" onSubmit={submit}>
        <label>
          Rating
          <select name="rating" defaultValue={current?.rating ?? 5} required>
            {[5, 4, 3, 2, 1].map((rating) => (
              <option value={rating} key={rating}>
                {rating} / 5
              </option>
            ))}
          </select>
        </label>
        <label>
          Your review
          <textarea name="body" rows={4} maxLength={1000} defaultValue={current?.body ?? ""} />
        </label>
        <label>
          Photos (up to 3; JPEG, PNG, or WebP; 1 MB each)
          <input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple />
        </label>
        <Button disabled={busy}>{current ? "Save review" : "Submit review"}</Button>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
