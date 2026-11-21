"use client";

import { useEffect, useState } from "react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

type Review = {
  id: string;
  rating: number;
  body: string;
  status: string;
  createdAt: string;
  providerReply: string | null;
  customer: { name: string };
  staff: { name: string };
};

export function ProviderReviewManager() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  async function refresh() {
    setReviews((await api<{ reviews: Review[] }>("/api/provider/reviews")).reviews);
  }

  useEffect(() => {
    let active = true;
    void api<{ reviews: Review[] }>("/api/provider/reviews")
      .then((result) => {
        if (active) setReviews(result.reviews);
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function reply(event: React.FormEvent<HTMLFormElement>, reviewId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(reviewId);
    setError("");
    try {
      await api(
        `/api/provider/reviews/${reviewId}`,
        jsonRequest("PATCH", { reply: String(form.get("reply") ?? "") }),
      );
      setNotice("Your reply was published.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="studio-stack">
      <h2>Customer reviews</h2>
      {reviews.length ? (
        reviews.map((review) => (
          <article className="panel studio-stack" key={review.id}>
            <div className="dash-heading">
              <h3>
                {review.customer.name} · {review.rating} / 5
              </h3>
              <span className="muted">
                {review.staff.name} · {new Date(review.createdAt).toLocaleDateString("en-IN")}
              </span>
            </div>
            {review.body && <p>{review.body}</p>}
            {review.status !== "PUBLISHED" && <p className="muted">This review is hidden by moderation.</p>}
            {review.providerReply ? (
              <p>
                <strong>Your reply:</strong> {review.providerReply}
              </p>
            ) : review.status === "PUBLISHED" ? (
              <form className="form-stack" onSubmit={(event) => void reply(event, review.id)}>
                <label>
                  Reply once
                  <textarea name="reply" maxLength={1000} rows={3} required />
                </label>
                <Button size="sm" disabled={busy === review.id}>
                  Post reply
                </Button>
              </form>
            ) : null}
          </article>
        ))
      ) : (
        <div className="empty-state">No customer reviews yet.</div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
