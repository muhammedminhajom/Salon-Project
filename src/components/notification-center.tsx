"use client";

import { useEffect, useState } from "react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

type Notice = {
  id: string;
  title: string;
  body: string;
  eventType: string;
  createdAt: string;
  readAt: string | null;
};

export function NotificationCenter() {
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");

  async function refresh() {
    const data = await api<{ notifications: Notice[]; unreadCount: number }>("/api/notifications");
    setItems(data.notifications);
    setUnread(data.unreadCount);
  }

  useEffect(() => {
    let active = true;
    void api<{ notifications: Notice[]; unreadCount: number }>("/api/notifications")
      .then((data) => {
        if (active) {
          setItems(data.notifications);
          setUnread(data.unreadCount);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function markRead() {
    const ids = items.filter((item) => !item.readAt).map((item) => item.id);
    if (!ids.length) return;
    try {
      await api("/api/notifications", jsonRequest("PATCH", { ids }));
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <details className="panel notification-center">
      <summary>Notifications {unread > 0 && <span className="status">{unread} unread</span>}</summary>
      {items.length ? (
        <div className="studio-stack">
          <div className="action-row">
            <Button size="sm" variant="outline" disabled={!unread} onClick={() => void markRead()}>
              Mark all read
            </Button>
          </div>
          {items.map((item) => (
            <article className="notification-item" key={item.id}>
              <div className="dash-heading">
                <strong>{item.title}</strong>
                <time className="muted" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("en-IN")}
                </time>
              </div>
              <p>{item.body}</p>
              {!item.readAt && <span className="status">Unread</span>}
            </article>
          ))}
        </div>
      ) : (
        <p>No notifications yet.</p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}
