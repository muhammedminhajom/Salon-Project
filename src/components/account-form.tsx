"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Mail, Smartphone } from "lucide-react";
import { api, jsonRequest } from "@/lib/client";
import { Button } from "@/components/ui/button";

type Flow = { destination: string };

export function AccountForm({
  register,
  initialType,
  next,
  sms,
  google,
  oauthError,
}: {
  register: boolean;
  initialType: string;
  next: string;
  sms: boolean;
  google: boolean;
  oauthError?: string;
}) {
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [type, setType] = useState(initialType);
  const [challenge, setChallenge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    oauthError === "account-exists"
      ? "An account already uses this email. Sign in with your email and password."
      : oauthError
        ? "Google sign-in could not be completed. Please try again."
        : "",
  );
  const [status, setStatus] = useState("");
  const query = new URLSearchParams({ ...(type ? { type } : {}), ...(next ? { next } : {}) });
  const switchUrl = `/account?${new URLSearchParams({ ...Object.fromEntries(query), mode: register ? "login" : "register" })}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "");
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const profile = register
        ? {
            name: value("name"),
            ...(type ? { type } : {}),
            ...(!type && value("referralCode")
              ? { referralCode: value("referralCode").trim().toUpperCase() }
              : {}),
          }
        : {};
      let flow: Flow;
      if (method === "email") {
        flow = await api<Flow>(
          `/api/auth/${register ? "register" : "login"}`,
          jsonRequest("POST", {
            email: value("email").trim(),
            password: value("password"),
            ...profile,
          }),
        );
      } else if (challenge) {
        flow = await api<Flow>(
          "/api/auth/otp-check",
          jsonRequest("POST", { challenge, code: value("code").trim() }),
        );
      } else {
        const response = await api<{ challenge: string }>(
          "/api/auth/otp-send",
          jsonRequest("POST", { phone: value("phone").trim(), ...profile }),
        );
        setChallenge(response.challenge);
        setStatus("Enter the verification code sent to your phone.");
        return;
      }
      window.location.assign(next || flow.destination);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel auth-panel">
      {sms && (
        <div className="segmented" aria-label="Sign-in method">
          <button
            type="button"
            aria-pressed={method === "email"}
            onClick={() => {
              setMethod("email");
              setError("");
              setStatus("");
            }}
          >
            <Mail size={18} /> Email
          </button>
          <button
            type="button"
            aria-pressed={method === "phone"}
            onClick={() => {
              setMethod("phone");
              setError("");
              setStatus("");
            }}
          >
            <Smartphone size={18} /> Phone
          </button>
        </div>
      )}
      <form className="form-stack" onSubmit={submit}>
        {register && (method !== "phone" || !challenge) && (
          <>
            <label>
              Name
              <input name="name" maxLength={80} autoComplete="name" required />
            </label>
            <label>
              Account type
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="">Customer</option>
                <option value="SHOP">Salon or shop</option>
                <option value="ARTIST">Freelance artist</option>
              </select>
            </label>
            {!type && (
              <label>
                Referral code (optional)
                <input name="referralCode" autoCapitalize="characters" maxLength={24} />
              </label>
            )}
          </>
        )}
        {method === "email" ? (
          <>
            <label>
              Email address
              <input name="email" type="email" maxLength={254} autoComplete="email" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={register ? 10 : 1}
                maxLength={200}
                autoComplete={register ? "new-password" : "current-password"}
                required
              />
              {register && <small>Use at least 10 characters.</small>}
            </label>
          </>
        ) : challenge ? (
          <>
            <label>
              Verification code
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                minLength={4}
                maxLength={8}
                required
              />
            </label>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setChallenge("");
                setError("");
                setStatus("");
              }}
            >
              Use a different number
            </button>
          </>
        ) : (
          <label>
            Phone number
            <input name="phone" type="tel" placeholder="+91" autoComplete="tel" required />
            <small>Include the country code.</small>
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="form-success" role="status">
            {status}
          </p>
        )}
        <Button type="submit" size="lg" disabled={busy}>
          {busy
            ? "Please wait…"
            : method === "phone"
              ? challenge
                ? "Verify code"
                : "Send code"
              : register
                ? "Create account"
                : "Sign in"}
        </Button>
      </form>
      {!register && method === "email" && (
        <p className="auth-switch">
          <Link href="/account/reset-password">Forgot password?</Link>
        </p>
      )}
      {google && (
        <>
          <div className="form-divider">
            <span>or</span>
          </div>
          <Button className="full-width" variant="outline" asChild>
            <a href={`/api/auth/google?${query}`}>Continue with Google</a>
          </Button>
        </>
      )}
      <p className="auth-switch">
        {register ? "Already have an account?" : "New to Bloom & Blush?"}{" "}
        <Link href={switchUrl}>{register ? "Sign in" : "Create an account"}</Link>
      </p>
    </div>
  );
}
