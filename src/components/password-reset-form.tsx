"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api, jsonRequest } from "@/lib/client";

function subscribeToFragment(update: () => void) {
  window.addEventListener("hashchange", update);
  return () => window.removeEventListener("hashchange", update);
}

const pageFragment = () => window.location.hash;
const serverFragment = () => "";

export function PasswordResetForm() {
  const fragment = useSyncExternalStore(subscribeToFragment, pageFragment, serverFragment);
  const resetToken = new URLSearchParams(fragment.slice(1)).get("token");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "");
    setError("");
    setStatus("");
    setBusy(true);
    try {
      if (resetToken) {
        if (value("password") !== value("confirm")) {
          setError("The passwords do not match.");
          return;
        }
        await api(
          "/api/auth/password-reset-complete",
          jsonRequest("POST", { token: resetToken, password: value("password") }),
        );
        window.history.replaceState(null, "", window.location.pathname);
        setComplete(true);
        setStatus("Your password has been updated. Sign in with your new password.");
      } else {
        await api("/api/auth/password-reset-request", jsonRequest("POST", { email: value("email").trim() }));
        setStatus("If that address is registered for password sign-in, a reset link will arrive by email.");
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel auth-panel">
      {!complete && (
        <form className="form-stack" onSubmit={submit}>
          {resetToken ? (
            <>
              <label>
                New password
                <input
                  name="password"
                  type="password"
                  minLength={10}
                  maxLength={200}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label>
                Confirm password
                <input
                  name="confirm"
                  type="password"
                  minLength={10}
                  maxLength={200}
                  autoComplete="new-password"
                  required
                />
              </label>
            </>
          ) : (
            <label>
              Email address
              <input name="email" type="email" maxLength={254} autoComplete="email" required />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Please wait…" : resetToken ? "Update password" : "Send reset link"}
          </Button>
        </form>
      )}
      {status && (
        <p className="form-success" role="status">
          {status}
        </p>
      )}
      <p className="auth-switch">
        <Link href="/account">Back to sign in</Link>
      </p>
    </div>
  );
}
