"use client";

import { useEffect, useState } from "react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

type QueueReview = {
  id: string;
  rating: number;
  body: string;
  status: "PUBLISHED" | "HIDDEN" | "DELETED";
  customer: { name: string; email: string | null };
  provider: { displayName: string };
  staff: { name: string };
  reports: { id: string; reason: string; reporter: { name: string } }[];
};

export function AdminReviewModeration() {
  const [reviews, setReviews] = useState<QueueReview[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  async function refresh() {
    setReviews((await api<{ reviews: QueueReview[] }>("/api/admin/reviews")).reviews);
  }

  useEffect(() => {
    let active = true;
    void api<{ reviews: QueueReview[] }>("/api/admin/reviews")
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

  async function decide(id: string, status: QueueReview["status"]) {
    const reason = window.prompt(`Reason for ${status.toLowerCase()} this review`);
    if (!reason?.trim()) return;
    setBusy(id);
    setError("");
    try {
      await api("/api/admin/reviews", jsonRequest("PATCH", { id, status, reason }));
      setNotice(`Review ${status.toLowerCase()}.`);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="studio-stack">
      <h2>Review moderation queue</h2>
      {reviews.length ? (
        reviews.map((review) => (
          <article className="panel studio-stack" key={review.id}>
            <div className="dash-heading">
              <h3>
                {review.provider.displayName} · {review.rating} / 5
              </h3>
              <span className="status" data-status={review.status}>
                {review.status}
              </span>
            </div>
            <p>
              {review.customer.name} · {review.staff.name}
            </p>
            <p>{review.body || "No written comment."}</p>
            {review.reports.map((report) => (
              <p className="form-error" key={report.id}>
                Reported by {report.reporter.name}: {report.reason}
              </p>
            ))}
            <div className="action-row">
              <Button
                size="sm"
                disabled={busy === review.id}
                onClick={() => void decide(review.id, "PUBLISHED")}
              >
                Restore / keep visible
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === review.id}
                onClick={() => void decide(review.id, "HIDDEN")}
              >
                Hide
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === review.id}
                onClick={() => void decide(review.id, "DELETED")}
              >
                Delete
              </Button>
            </div>
          </article>
        ))
      ) : (
        <div className="empty-state">No reported or hidden reviews.</div>
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
