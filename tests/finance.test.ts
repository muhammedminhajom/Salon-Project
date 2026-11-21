import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellationQuote } from "../src/lib/cancellation";
import { portion, priceCheckout } from "../src/lib/money";
import { resolveCommissionBps } from "../src/lib/finance-ledger";

test("checkout computes GST and the default advance in integer paise", () => {
  const quote = priceCheckout({
    servicePaise: 10_001,
    travelPaise: 99,
    taxRateBps: 1800,
    depositBps: null,
    paymentMode: "DEPOSIT",
    availableWalletPaise: 212,
  });
  assert.equal(quote.taxPaise, 1818);
  assert.equal(quote.totalPaise, 11918);
  assert.equal(quote.gatewayAmountPaise, 2768);
  assert.equal(quote.dueAtVenuePaise, 8938);
  assert.equal(portion(1, 5000), 1);
});

test("wallet payments preserve the gateway minimum and venue balance", () => {
  const base = {
    servicePaise: 1000,
    travelPaise: 0,
    taxRateBps: 0,
    depositBps: 5000,
    availableWalletPaise: 950,
  };
  const online = priceCheckout({ ...base, paymentMode: "FULL_ONLINE" });
  assert.equal(online.walletUsedPaise, 900);
  assert.equal(online.gatewayAmountPaise, 100);
  const venue = priceCheckout({ ...base, paymentMode: "PAY_AT_VENUE" });
  assert.equal(venue.gatewayAmountPaise, 0);
  assert.equal(venue.dueAtVenuePaise, 50);
});

test("checkout discounts reduce the taxable base using whole paise", () => {
  const quote = priceCheckout({
    servicePaise: 10_001,
    travelPaise: 0,
    taxRateBps: 1800,
    depositBps: null,
    paymentMode: "FULL_ONLINE",
    availableWalletPaise: 0,
    discountPaise: 1001,
  });
  assert.equal(quote.discountPaise, 1001);
  assert.equal(quote.taxPaise, 1620);
  assert.equal(quote.totalPaise, 10_620);
});

test("commission resolution prefers provider, then category, then the platform default", () => {
  assert.equal(resolveCommissionBps(1000), 1000);
  assert.equal(resolveCommissionBps(1000, 1500), 1500);
  assert.equal(resolveCommissionBps(1000, 1500, 2200), 2200);
  assert.equal(resolveCommissionBps(1000, 1500, 0), 0);
  assert.equal(resolveCommissionBps(1000, 0, null), 0);
});

test("refund policy applies the free period, late fee, cutoff and provider/no-show rules", () => {
  const policy = {
    cancelBeforeHours: 12,
    freeRefundHours: 24,
    noRefundHours: 2,
    cancellationFeeBps: 3000,
    noShowFeeBps: 5000,
  };
  const base = { policy, totalPaise: 10_000, availablePaise: 5000, reason: "CUSTOMER_CANCEL" as const };
  assert.equal(cancellationQuote({ ...base, minutesBefore: 1440 }).refundPaise, 5000);
  assert.equal(cancellationQuote({ ...base, minutesBefore: 1439 }).refundPaise, 2000);
  assert.equal(cancellationQuote({ ...base, minutesBefore: 120 }).refundPaise, 0);
  assert.equal(
    cancellationQuote({ ...base, minutesBefore: 60, reason: "PROVIDER_CANCEL" }).refundPaise,
    5000,
  );
  assert.equal(cancellationQuote({ ...base, minutesBefore: 0, reason: "NO_SHOW" }).retainedPaise, 5000);
});
