"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Payout = {
  id: string;
  providerId: string;
  amountPaise: number;
  currency: string;
  status: "PENDING" | "APPROVED" | "PAID" | "FAILED";
  reference: string | null;
  failureNote: string | null;
  createdAt: string;
  eligibleAt: string;
  provider: { id: string; displayName: string; destination: null | { type: string; [key: string]: string } };
};

type Dashboard = {
  defaultCommissionBps: number;
  minimumPayoutPaise: number;
  payoutCycleDays: number;
  loyaltyPointsPerVisit: number;
  loyaltyPaisePerPoint: number;
  loyaltyExpiryDays: number;
  referralRewardPaise: number;
  gmvPaise: number;
  commissionPaise: number;
  providerPayablePaise: number;
  taxPayablePaise: number;
  totalProviderObligationPaise: number;
  providerDuesPaise: number;
  payoutsPaidPaise: number;
  pendingPayoutPaise: number;
  gatewayCapturedPaise: number;
  gatewayFeesPaise: number;
  gatewayRefundedPaise: number;
  gatewayLedgerBalancePaise: number;
  expectedGatewayBalancePaise: number;
  gatewayDifferencePaise: number;
  categories: { id: string; name: string; commissionBps: number | null }[];
  providers: { id: string; displayName: string; commissionBps: number | null }[];
};

function amountPaise(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter a valid rupee amount.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > 2_147_483_647n) throw new Error("The amount is too large.");
  return Number(amount);
}

function mask(destination: Payout["provider"]["destination"]) {
  if (!destination) return "Missing payout destination";
  if (destination.type === "UPI") return (destination.upiId ?? "").replace(/^(.{1,2})[^@]+/, "$1••••");
  return `${destination.accountHolderName ?? ""} · account ending ${destination.accountNumber?.slice(-4) ?? "••••"} · IFSC ending ${destination.ifsc?.slice(-2) ?? "••"}`;
}

export function AdminFinance() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"CATEGORY" | "PROVIDER">("CATEGORY");

  async function refresh() {
    const [summary, payoutResult] = await Promise.all([
      api<Dashboard>("/api/admin/finance"),
      api<{ payouts: Payout[] }>("/api/admin/finance/payouts"),
    ]);
    setDashboard(summary);
    setPayouts(payoutResult.payouts);
    setSelection((current) => current.filter((id) => payoutResult.payouts.some((item) => item.id === id)));
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Dashboard>("/api/admin/finance"),
      api<{ payouts: Payout[] }>("/api/admin/finance/payouts"),
    ])
      .then(([summary, payoutResult]) => {
        if (!active) return;
        setDashboard(summary);
        setPayouts(payoutResult.payouts);
      })
      .catch((cause: unknown) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dashboard) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/finance",
        jsonRequest("PUT", {
          defaultCommissionBps: Math.round(Number(form.get("commission")) * 100),
          minimumPayoutPaise: amountPaise(String(form.get("minimum"))),
          payoutCycleDays: Number(form.get("cycle")),
          loyaltyPointsPerVisit: Number(form.get("pointsPerVisit")),
          loyaltyPaisePerPoint: Number(form.get("pointValue")),
          loyaltyExpiryDays: Number(form.get("pointsExpiry")),
          referralRewardPaise: amountPaise(String(form.get("referralReward"))),
        }),
      );
      setNotice("Finance settings saved.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/finance/commissions",
        jsonRequest("PATCH", {
          scope,
          id: String(form.get("id")),
          commissionBps:
            String(form.get("commission")) === "" ? null : Math.round(Number(form.get("commission")) * 100),
        }),
      );
      setNotice("Commission override saved.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function payoutAction(action: "APPROVE" | "REJECT" | "MARK_PAID" | "RETRY") {
    if (!selection.length) return;
    const reference = action === "MARK_PAID" ? window.prompt("Enter the bank transfer reference") : null;
    if (action === "MARK_PAID" && !reference?.trim()) return;
    const reason = action === "REJECT" ? window.prompt("Enter the rejection reason") : null;
    if (action === "REJECT" && !reason?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/finance/payouts",
        jsonRequest("PATCH", {
          payoutIds: selection,
          action,
          ...(reference ? { reference } : {}),
          ...(reason ? { reason } : {}),
        }),
      );
      setNotice(`Payout request${selection.length === 1 ? "" : "s"} updated.`);
      setSelection([]);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!dashboard) return <section className="panel">Loading finance dashboard…</section>;

  const metrics = [
    ["GMV", dashboard.gmvPaise],
    ["Commission earned", dashboard.commissionPaise],
    ["Provider net payable", dashboard.providerPayablePaise],
    ["Provider tax payable", dashboard.taxPayablePaise],
    ["Total provider obligation", dashboard.totalProviderObligationPaise],
    ["Venue commission dues", dashboard.providerDuesPaise],
    ["Pending payouts", dashboard.pendingPayoutPaise],
    ["Payouts paid", dashboard.payoutsPaidPaise],
  ] as const;
  const options = scope === "CATEGORY" ? dashboard.categories : dashboard.providers;

  return (
    <div className="studio-stack">
      <div className="stat-grid">
        {metrics.map(([label, value]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{money(value)}</strong>
          </div>
        ))}
      </div>
      <section className="panel studio-stack">
        <div className="dash-heading">
          <h2>Gateway reconciliation</h2>
          <a className="back-link" href="/api/admin/finance?format=csv">
            Download finance CSV
          </a>
        </div>
        <p>
          Captured {money(dashboard.gatewayCapturedPaise)} · Refunded to gateway{" "}
          {money(dashboard.gatewayRefundedPaise)} · Fees {money(dashboard.gatewayFeesPaise)} · Paid out{" "}
          {money(dashboard.payoutsPaidPaise)}
        </p>
        <p>
          Expected clearing {money(dashboard.expectedGatewayBalancePaise)} · Ledger clearing{" "}
          {money(dashboard.gatewayLedgerBalancePaise)} · Difference {money(dashboard.gatewayDifferencePaise)}
        </p>
      </section>
      <section className="panel studio-stack">
        <h2>Commission and payout rules</h2>
        <form className="inline-form" onSubmit={saveSettings}>
          <label>
            Default commission (%)
            <input
              name="commission"
              type="number"
              min="0"
              max="100"
              step="0.01"
              defaultValue={dashboard.defaultCommissionBps / 100}
              required
            />
          </label>
          <label>
            Minimum payout (₹)
            <input
              name="minimum"
              inputMode="decimal"
              defaultValue={(dashboard.minimumPayoutPaise / 100).toFixed(2)}
              required
            />
          </label>
          <label>
            Cycle (days)
            <input
              name="cycle"
              type="number"
              min="1"
              max="31"
              defaultValue={dashboard.payoutCycleDays}
              required
            />
          </label>
          <label>
            Points per completed visit
            <input
              name="pointsPerVisit"
              type="number"
              min="0"
              max="100000"
              defaultValue={dashboard.loyaltyPointsPerVisit}
              required
            />
          </label>
          <label>
            Point value (paise)
            <input
              name="pointValue"
              type="number"
              min="1"
              max="100000"
              defaultValue={dashboard.loyaltyPaisePerPoint}
              required
            />
          </label>
          <label>
            Points expiry (days)
            <input
              name="pointsExpiry"
              type="number"
              min="30"
              max="3650"
              defaultValue={dashboard.loyaltyExpiryDays}
              required
            />
          </label>
          <label>
            Referral reward each (₹)
            <input
              name="referralReward"
              inputMode="decimal"
              defaultValue={(dashboard.referralRewardPaise / 100).toFixed(2)}
              required
            />
          </label>
          <Button disabled={busy}>Save rules</Button>
        </form>
        <form className="inline-form" onSubmit={saveOverride}>
          <label>
            Override scope
            <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
              <option value="CATEGORY">Category</option>
              <option value="PROVIDER">Provider</option>
            </select>
          </label>
          <label>
            Target
            <select name="id" required>
              {options.map((item) => (
                <option value={item.id} key={item.id}>
                  {"name" in item ? item.name : item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Commission (%)
            <input
              name="commission"
              type="number"
              min="0"
              max="100"
              step="0.01"
              placeholder="Clear override"
            />
          </label>
          <Button variant="outline" disabled={busy || !options.length}>
            Save override
          </Button>
        </form>
        <p>
          Resolution order: provider override, then category override, then platform default. Each booking
          stores the rate used.
        </p>
      </section>
      <section className="panel studio-stack">
        <h2>Payout review</h2>
        <div className="action-row">
          <Button size="sm" disabled={busy || !selection.length} onClick={() => void payoutAction("APPROVE")}>
            Approve selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !selection.length}
            onClick={() => void payoutAction("MARK_PAID")}
          >
            Mark paid
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !selection.length}
            onClick={() => void payoutAction("RETRY")}
          >
            Retry failed
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !selection.length}
            onClick={() => void payoutAction("REJECT")}
          >
            Reject selected
          </Button>
        </div>
        {payouts.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <caption className="sr-only">Provider payout requests</caption>
              <thead>
                <tr>
                  <th className="p-2">Select</th>
                  <th className="p-2">Provider</th>
                  <th className="p-2">Destination</th>
                  <th className="p-2">Amount</th>
                  <th className="p-2">Eligible</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Reference / note</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((payout) => (
                  <tr key={payout.id} className="border-t">
                    <td className="p-2">
                      <input
                        aria-label={`Select payout ${payout.id}`}
                        type="checkbox"
                        checked={selection.includes(payout.id)}
                        onChange={(event) =>
                          setSelection((current) =>
                            event.target.checked
                              ? [...current, payout.id]
                              : current.filter((id) => id !== payout.id),
                          )
                        }
                      />
                    </td>
                    <th scope="row" className="p-2">
                      {payout.provider.displayName}
                    </th>
                    <td className="p-2">{mask(payout.provider.destination)}</td>
                    <td className="p-2">{money(payout.amountPaise)}</td>
                    <td className="p-2">{new Date(payout.eligibleAt).toLocaleDateString("en-IN")}</td>
                    <td className="p-2">{payout.status}</td>
                    <td className="p-2">{payout.reference ?? payout.failureNote ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No payout requests.</p>
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
