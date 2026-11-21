"use client";

import { useEffect } from "react";
import { refreshBrowserSession } from "@/lib/client";

export function SessionRestore({ next }: { next: string }) {
  useEffect(() => {
    let active = true;
    void refreshBrowserSession().then((refreshed) => {
      if (active) window.location.replace(refreshed ? next : `/account?next=${encodeURIComponent(next)}`);
    });
    return () => {
      active = false;
    };
  }, [next]);
  return <p role="status">Restoring your session…</p>;
}
