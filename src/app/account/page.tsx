import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { googleReady, smsReady } from "@/lib/auth-endpoints";
import { getViewer, roleHome } from "@/lib/auth";
import { safeNext } from "@/lib/http";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const register = params.mode === "register";
  const next = safeNext(typeof params.next === "string" ? params.next : "", "");
  const user = await getViewer();
  if (user) redirect(next || roleHome(user.role));
  const initialType = params.type === "SHOP" || params.type === "ARTIST" ? params.type : "";
  return (
    <section className="auth-background">
      <div className="auth-wrap">
        <div className="section-head center">
          <h1>{register ? "Create your account" : "Welcome back"}</h1>
          <p>
            {register
              ? "Start booking appointments or list your beauty business."
              : "Sign in to manage your appointments or studio."}
          </p>
        </div>
        <AccountForm
          key={String(register)}
          register={register}
          initialType={initialType}
          next={next}
          sms={smsReady()}
          google={googleReady()}
          oauthError={params.error}
        />
      </div>
    </section>
  );
}
