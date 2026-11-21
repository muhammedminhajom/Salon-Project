"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Coupon = {
  id: string;
  code: string;
  kind: string;
  discountType: "PERCENT" | "FLAT";
  amount: number;
  funding: string;
  usageCount: number;
  totalUses: number | null;
  validUntil: string;
  active: boolean;
};

function paise(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter a valid rupee amount.");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > 2_147_483_647n) throw new Error("The amount is too large.");
  return Number(result);
}

export function CouponManager({
  scope,
  categories = [],
  providers = [],
}: {
  scope: "admin" | "provider";
  categories?: { id: string; name: string }[];
  providers?: { id: string; name: string }[];
}) {
  const endpoint = `/api/${scope}/coupons`;
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    setCoupons((await api<{ coupons: Coupon[] }>(endpoint)).coupons);
  }

  useEffect(() => {
    let active = true;
    void api<{ coupons: Coupon[] }>(endpoint)
      .then((result) => {
        if (active) setCoupons(result.coupons);
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const kind = String(form.get("kind"));
      const discountType = String(form.get("discountType"));
      const rawAmount = String(form.get("amount"));
      const amount = discountType === "PERCENT" ? Math.round(Number(rawAmount) * 100) : paise(rawAmount);
      const input = {
        code: String(form.get("code")).trim().toUpperCase(),
        kind,
        discountType,
        funding: scope === "admin" ? "PLATFORM" : "PROVIDER",
        amount,
        maxDiscountPaise: form.get("maxDiscount") ? paise(String(form.get("maxDiscount"))) : null,
        minCartPaise: paise(String(form.get("minimum") || "0")),
        totalUses: form.get("totalUses") ? Number(form.get("totalUses")) : null,
        perUserLimit: Number(form.get("perUserLimit") || 1),
        validFrom: new Date(String(form.get("validFrom"))).toISOString(),
        validUntil: new Date(String(form.get("validUntil"))).toISOString(),
        categoryId: form.get("categoryId") ? String(form.get("categoryId")) : null,
        providerId: scope === "admin" && kind === "PROVIDER" ? String(form.get("providerId")) : null,
        active: form.get("active") === "on",
      };
      await api(endpoint, jsonRequest("POST", input));
      formElement.reset();
      setNotice("Coupon created.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string, active: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(endpoint, jsonRequest("PATCH", { id, active }));
      setNotice(active ? "Coupon activated." : "Coupon deactivated.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-stack">
      <section className="panel studio-stack">
        <h2>{scope === "admin" ? "Platform coupon manager" : "Provider offers"}</h2>
        <p>
          {scope === "admin"
            ? "Platform-funded discounts are charged to the marketplace."
            : "Your discounts are funded by your studio and reduce your service proceeds."}
        </p>
        <form className="form-stack" onSubmit={create}>
          <div className="two-grid studio-form-grid">
            <label>
              Code
              <input name="code" maxLength={40} pattern="[A-Za-z0-9_-]{3,40}" required />
            </label>
            <label>
              Rule
              <select name="kind" defaultValue="PERCENT">
                <option value="PERCENT">Any eligible booking</option>
                <option value="FLAT">Flat offer</option>
                <option value="FIRST_BOOKING">First booking</option>
                <option value="CATEGORY">Category-specific</option>
                <option value="PROVIDER">Provider-specific</option>
              </select>
            </label>
            <label>
              Discount type
              <select name="discountType" defaultValue="PERCENT">
                <option value="PERCENT">Percent</option>
                <option value="FLAT">Flat amount</option>
              </select>
            </label>
            <label>
              Amount
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="Percent or rupees"
                required
              />
            </label>
            <label>
              Maximum discount (₹)
              <input name="maxDiscount" inputMode="decimal" />
            </label>
            <label>
              Minimum cart (₹)
              <input name="minimum" inputMode="decimal" defaultValue="0" />
            </label>
            <label>
              Total uses
              <input name="totalUses" type="number" min="1" />
            </label>
            <label>
              Uses per customer
              <input name="perUserLimit" type="number" min="1" max="1000" defaultValue="1" required />
            </label>
            <label>
              Starts
              <input name="validFrom" type="datetime-local" required />
            </label>
            <label>
              Ends
              <input name="validUntil" type="datetime-local" required />
            </label>
            {scope === "admin" && (
              <label>
                Provider target
                <select name="providerId" defaultValue="">
                  <option value="">Choose if provider-specific</option>
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Category target
              <select name="categoryId" defaultValue="">
                <option value="">Choose if category-specific</option>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              <input name="active" type="checkbox" defaultChecked />
              Active immediately
            </label>
          </div>
          <Button disabled={busy}>Create coupon</Button>
        </form>
      </section>
      <section className="panel studio-stack">
        <h2>Current coupons</h2>
        {coupons.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <caption className="sr-only">Coupon campaigns</caption>
              <thead>
                <tr>
                  <th className="p-2">Code</th>
                  <th className="p-2">Rule</th>
                  <th className="p-2">Discount</th>
                  <th className="p-2">Funding</th>
                  <th className="p-2">Uses</th>
                  <th className="p-2">Ends</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon) => (
                  <tr key={coupon.id} className="border-t">
                    <th scope="row" className="p-2">
                      {coupon.code}
                    </th>
                    <td className="p-2">{coupon.kind.replaceAll("_", " ")}</td>
                    <td className="p-2">
                      {coupon.discountType === "PERCENT" ? `${coupon.amount / 100}%` : money(coupon.amount)}
                    </td>
                    <td className="p-2">{coupon.funding}</td>
                    <td className="p-2">
                      {coupon.usageCount}
                      {coupon.totalUses === null ? "" : ` / ${coupon.totalUses}`}
                    </td>
                    <td className="p-2">{new Date(coupon.validUntil).toLocaleDateString("en-IN")}</td>
                    <td className="p-2">{coupon.active ? "Active" : "Paused"}</td>
                    <td className="p-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void setActive(coupon.id, !coupon.active)}
                      >
                        {coupon.active ? "Pause" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No coupon campaigns.</p>
        )}
      </section>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
