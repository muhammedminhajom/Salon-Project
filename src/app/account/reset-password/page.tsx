import type { Metadata } from "next";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = { title: "Reset password", referrer: "no-referrer" };

export default function PasswordResetPage() {
  return (
    <section className="auth-background">
      <div className="auth-wrap">
        <div className="section-head center">
          <h1>Reset your password</h1>
        </div>
        <PasswordResetForm />
      </div>
    </section>
  );
}
