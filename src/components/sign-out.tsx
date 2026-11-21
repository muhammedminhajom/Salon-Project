"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";

export function SignOut({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <span className="sign-out">
      <Button
        title="Sign out"
        aria-label="Sign out"
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api("/api/auth/logout", { method: "POST" });
            router.replace("/");
            router.refresh();
            setBusy(false);
          } catch (cause) {
            setError((cause as Error).message);
            setBusy(false);
          }
        }}
      >
        <LogOut size={17} />
        {!compact && "Sign out"}
      </Button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
