"use client";

import { useState, type FormEvent } from "react";
import type { getProviderFinance } from "@/lib/finance";
import { api, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type FinanceData = Awaited<ReturnType<typeof getProviderFinance>>;

function parsePaise(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter an amount with up to two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > 2_147_483_647n) throw new Error("The amount exceeds the supported limit.");
  return Number(paise);
}

export function ProviderFinance({
  initial,
  staff,
  minimumPayoutPaise,
}: {
  initial: Exclude<FinanceData, string>;
  staff: { id: string; name: string }[];
  minimumPayoutPaise: number;
}) {
  const [data, setData] = useState(initial);
  const [type, setType] = useState<"UPI" | "BANK">("UPI");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) params.append(key, String(value));
    try {
      setData(await api<Exclude<FinanceData, string>>("/api/provider/finance?" + params));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function savePayoutDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const details =
      type === "UPI"
        ? { type, upiId: String(form.get("upiId") ?? "") }
        : {
            type,
            accountHolderName: String(form.get("accountHolderName") ?? ""),
            accountNumber: String(form.get("accountNumber") ?? ""),
            ifsc: String(form.get("ifsc") ?? ""),
          };
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await api<{ payoutDetails: { details: unknown } }>(
        "/api/provider/finance/payout-details",
        jsonRequest("PUT", details),
      );
      setData({ ...data, payoutDetailsAdded: true });
      setNotice("Encrypted payout details saved.");
      void result;
      formElement.reset();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function requestPayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const amountPaise = parsePaise(String(new FormData(formElement).get("amount") ?? ""));
      await api(
        "/api/provider/finance",
        jsonRequest("POST", { amountPaise, requestKey: crypto.randomUUID() }),
      );
      setNotice("Payout request submitted for approval.");
      setData(await api<Exclude<FinanceData, string>>("/api/provider/finance"));
      formElement.reset();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-stack">
      <section className="panel form-stack">
        <h2>Earnings and payouts</h2>
        <p>
          Available {money(data.balance.availablePaise)} · Provider net {money(data.balance.providerNetPaise)}{" "}
          · Tax payable {money(data.balance.taxPayablePaise)} · Pending {money(data.balance.reservedPaise)} ·
          Provider dues {money(data.balance.duesPaise)}
        </p>
        <form className="inline-form" onSubmit={requestPayout}>
          <label>
            Payout amount (₹)
            <input name="amount" inputMode="decimal" placeholder="5000.00" required />
          </label>
          <Button disabled={busy || !data.payoutDetailsAdded}>Request payout</Button>
        </form>
        <p>
          Minimum payout {money(minimumPayoutPaise)}. Approved requests are included in the next payout run.
        </p>
        {data.payouts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <caption className="sr-only">Provider payout requests</caption>
              <thead>
                <tr>
                  <th scope="col" className="p-2">
                    Requested
                  </th>
                  <th scope="col" className="p-2">
                    Eligible
                  </th>
                  <th scope="col" className="p-2">
                    Amount
                  </th>
                  <th scope="col" className="p-2">
                    Status
                  </th>
                  <th scope="col" className="p-2">
                    Reference
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.payouts.map((payout) => (
                  <tr key={payout.id}>
                    <td className="p-2">{new Date(payout.createdAt).toLocaleDateString("en-IN")}</td>
                    <td className="p-2">{new Date(payout.eligibleAt).toLocaleDateString("en-IN")}</td>
                    <td className="p-2">{money(payout.amountPaise)}</td>
                    <td className="p-2">{payout.status}</td>
                    <td className="p-2">{payout.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel form-stack">
        <h2>Payout destination</h2>
        <p>
          {data.payoutDetailsAdded
            ? "A payout destination is saved securely. Saving a new one replaces it."
            : "Save a bank account or UPI ID before requesting a payout."}
        </p>
        <form className="form-stack" onSubmit={savePayoutDetails}>
          <label>
            Destination type
            <select value={type} onChange={(event) => setType(event.target.value as "UPI" | "BANK")}>
              <option value="UPI">UPI</option>
              <option value="BANK">Bank account</option>
            </select>
          </label>
          {type === "UPI" ? (
            <label>
              UPI ID
              <input name="upiId" maxLength={120} required />
            </label>
          ) : (
            <>
              <label>
                Account holder
                <input name="accountHolderName" maxLength={100} required />
              </label>
              <label>
                Account number
                <input name="accountNumber" inputMode="numeric" minLength={9} maxLength={18} required />
              </label>
              <label>
                IFSC
                <input name="ifsc" minLength={11} maxLength={11} required />
              </label>
            </>
          )}
          <Button variant="outline" disabled={busy}>
            Save payout destination
          </Button>
        </form>
      </section>

      <section className="panel studio-stack">
        <div className="dash-heading">
          <h2>Ledger</h2>
          <Link className="back-link" href="/api/provider/finance?format=csv">
            Download CSV
          </Link>
        </div>
        <form className="inline-form" onSubmit={filter}>
          <label>
            From
            <input name="from" type="date" />
          </label>
          <label>
            Through
            <input name="until" type="date" />
          </label>
          <label>
            Staff
            <select name="staff" defaultValue="">
              <option value="">All staff</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline">Filter</Button>
        </form>
        {data.ledger.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <caption className="sr-only">Provider financial ledger</caption>
              <thead>
                <tr>
                  <th scope="col" className="p-2">
                    Date
                  </th>
                  <th scope="col" className="p-2">
                    Appointment
                  </th>
                  <th scope="col" className="p-2">
                    Staff
                  </th>
                  <th scope="col" className="p-2">
                    Account
                  </th>
                  <th scope="col" className="p-2">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="p-2">{new Date(entry.createdAt).toLocaleDateString("en-IN")}</td>
                    <td className="p-2">
                      {entry.booking ? new Date(entry.booking.startsAt).toLocaleDateString("en-IN") : "—"}
                    </td>
                    <td className="p-2">{entry.staff?.name ?? "—"}</td>
                    <td className="p-2">{entry.account.replaceAll("_", " ")}</td>
                    <td className="p-2">{money(entry.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No financial entries for this filter yet.</p>
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
