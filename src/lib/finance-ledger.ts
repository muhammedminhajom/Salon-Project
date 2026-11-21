import type { LedgerAccount, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { lockProvider } from "@/lib/provider-lock";
import { currency, portion } from "@/lib/money";

type Tx = Prisma.TransactionClient;
type LedgerLine = { account: LedgerAccount; amountPaise: number };

function prorate(amountPaise: number, partPaise: number, wholePaise: number) {
  if (amountPaise <= 0 || partPaise <= 0 || wholePaise <= 0) return 0;
  const amount = BigInt(amountPaise);
  const part = BigInt(Math.min(partPaise, wholePaise));
  const whole = BigInt(wholePaise);
  return Number((amount * part + whole / 2n) / whole);
}

export function resolveCommissionBps(
  defaultBps: number,
  categoryBps?: number | null,
  providerBps?: number | null,
) {
  return providerBps ?? categoryBps ?? defaultBps;
}

function combinedLines(lines: LedgerLine[]) {
  const totals = new Map<LedgerAccount, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountPaise)) throw new HttpError(400, "Finance entries use whole paise.");
    totals.set(line.account, (totals.get(line.account) ?? 0) + line.amountPaise);
  }
  const entries = [...totals]
    .filter(([, amountPaise]) => amountPaise !== 0)
    .map(([account, amountPaise]) => ({ account, amountPaise }));
  if (!entries.length || entries.reduce((sum, entry) => sum + entry.amountPaise, 0) !== 0) {
    throw new HttpError(409, "The finance entry does not balance.");
  }
  return entries;
}

export async function postLedgerBatch(
  tx: Tx,
  input: {
    reference: string;
    source: string;
    providerId?: string;
    bookingId?: string;
    staffId?: string;
    actorId?: string;
    lines: LedgerLine[];
  },
) {
  const entries = combinedLines(input.lines);
  const prior = await tx.ledgerBatch.findUnique({
    where: { reference: input.reference },
    include: { entries: { orderBy: { account: "asc" } } },
  });
  if (prior) {
    const matches =
      prior.source === input.source &&
      entries.length === prior.entries.length &&
      entries.every((entry) =>
        prior.entries.some(
          (previous) => previous.account === entry.account && previous.amountPaise === entry.amountPaise,
        ),
      );
    if (!matches) throw new HttpError(409, "A finance reference was reused with different amounts.");
    return { batch: prior, created: false };
  }
  const batch = await tx.ledgerBatch.create({
    data: {
      reference: input.reference,
      source: input.source,
      entries: {
        create: entries.map((entry) => ({
          ...entry,
          currency,
          providerId: input.providerId,
          bookingId: input.bookingId,
          staffId: input.staffId,
        })),
      },
    },
    include: { entries: true },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      targetId: input.bookingId ?? input.providerId ?? "platform",
      action: "FINANCE_LEDGER_POSTED",
      metadata: { reference: input.reference, source: input.source, currency },
    },
  });
  return { batch, created: true };
}

export async function recordBookingCompletion(tx: Tx, bookingId: string, actorId?: string) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: { items: true, payment: true, couponUsage: true },
  });
  if (!booking || !["COMPLETED", "NO_SHOW"].includes(booking.status)) {
    throw new HttpError(409, "Only a completed or no-show appointment can be settled.");
  }

  const grossCommissionPaise = booking.items.reduce(
    (sum, item) => sum + portion(item.pricePaise, item.commissionBps),
    0,
  );
  const commissionBps = booking.totalPaise
    ? Math.min(10_000, Math.round((grossCommissionPaise * 10_000) / booking.totalPaise))
    : 0;
  const providerDiscountPaise =
    booking.couponUsage?.funding === "PROVIDER" ? booking.couponUsage.discountPaise : 0;
  const commissionPaise = Math.max(0, grossCommissionPaise - portion(providerDiscountPaise, commissionBps));
  const platformDiscountPaise =
    booking.loyaltyDiscountPaise +
    (booking.couponUsage?.funding === "PLATFORM" ? booking.couponUsage.discountPaise : 0);
  const commissionOnSettlement =
    booking.status === "NO_SHOW" ? portion(booking.retainedFeePaise, commissionBps) : commissionPaise;
  if (
    !commissionOnSettlement &&
    !booking.payment?.gatewayCapturedPaise &&
    !booking.payment?.walletUsedPaise
  ) {
    return { batch: null, created: false };
  }
  let lines: LedgerLine[];
  if (booking.paymentMode === "PAY_AT_VENUE") {
    lines = [
      { account: "PROVIDER_DUES", amountPaise: commissionOnSettlement },
      { account: "PLATFORM_REVENUE", amountPaise: -commissionOnSettlement },
      ...(platformDiscountPaise
        ? [
            { account: "CUSTOMER_RECEIVABLE" as const, amountPaise: platformDiscountPaise },
            { account: "PROVIDER_PAYABLE" as const, amountPaise: -platformDiscountPaise },
            { account: "PLATFORM_REVENUE" as const, amountPaise: platformDiscountPaise },
          ]
        : []),
    ];
  } else {
    const payment = booking.payment;
    const collectedPaise = payment
      ? payment.gatewayCapturedPaise + payment.walletUsedPaise - payment.refundedPaise
      : 0;
    const settlementFunds = collectedPaise + platformDiscountPaise;
    const appliedCommission = Math.min(commissionOnSettlement, settlementFunds);
    const duesPaise = commissionOnSettlement - appliedCommission;
    const payablePaise = settlementFunds - appliedCommission;
    const fundedTaxPaise = prorate(
      booking.taxPaise,
      Math.min(settlementFunds, booking.totalPaise),
      booking.totalPaise,
    );
    const taxPayablePaise = Math.min(payablePaise, fundedTaxPaise);
    lines = [
      { account: "CUSTOMER_FUNDS", amountPaise: collectedPaise },
      { account: "CUSTOMER_RECEIVABLE", amountPaise: platformDiscountPaise },
      { account: "PROVIDER_PAYABLE", amountPaise: -(payablePaise - taxPayablePaise) },
      { account: "TAX_PAYABLE", amountPaise: -taxPayablePaise },
      { account: "PROVIDER_DUES", amountPaise: duesPaise },
      { account: "PLATFORM_REVENUE", amountPaise: -commissionOnSettlement },
    ];
    if (payment?.gatewayFeePaise) {
      lines.push(
        { account: "GATEWAY_FEE", amountPaise: payment.gatewayFeePaise },
        { account: "GATEWAY_CLEARING", amountPaise: -payment.gatewayFeePaise },
      );
    }
  }
  return postLedgerBatch(tx, {
    reference: "booking-completion:" + bookingId,
    source: "BOOKING_COMPLETED",
    bookingId,
    providerId: booking.providerId,
    staffId: booking.staffId,
    actorId,
    lines,
  });
}

export async function recordGatewayCapture(
  tx: Tx,
  input: {
    paymentId: string;
    bookingId: string;
    providerId: string;
    staffId: string;
    amountPaise: number;
    actorId?: string;
  },
) {
  if (input.amountPaise <= 0) return;
  await postLedgerBatch(tx, {
    reference: "gateway-capture:" + input.paymentId,
    source: "PAYMENT_CAPTURED",
    providerId: input.providerId,
    bookingId: input.bookingId,
    actorId: input.actorId,
    staffId: input.staffId,
    lines: [
      { account: "GATEWAY_CLEARING", amountPaise: input.amountPaise },
      { account: "CUSTOMER_FUNDS", amountPaise: -input.amountPaise },
    ],
  });
}

export async function recordRefund(
  tx: Tx,
  input: {
    refundId: string;
    bookingId: string;
    providerId: string;
    staffId: string;
    amountPaise: number;
    gatewayPaise: number;
    walletCreditPaise: number;
    commissionBps: number;
    destination: "ORIGINAL" | "WALLET";
    actorId?: string;
  },
) {
  const walletPaise = input.destination === "WALLET" ? input.amountPaise : input.walletCreditPaise;
  const gatewayPaise = input.destination === "ORIGINAL" ? input.gatewayPaise : 0;
  if (walletPaise + gatewayPaise !== input.amountPaise) {
    throw new HttpError(409, "The refund allocation does not balance.");
  }
  const completion = await tx.ledgerBatch.findUnique({
    where: { reference: "booking-completion:" + input.bookingId },
    select: { id: true },
  });
  const booking = completion
    ? await tx.booking.findUnique({
        where: { id: input.bookingId },
        select: { taxPaise: true, totalPaise: true },
      })
    : null;
  const commissionRefundPaise = portion(input.amountPaise, input.commissionBps);
  const taxRefundPaise = booking
    ? Math.min(
        input.amountPaise - commissionRefundPaise,
        prorate(input.amountPaise, booking.taxPaise, booking.totalPaise),
      )
    : 0;
  const providerRefundPaise = input.amountPaise - commissionRefundPaise - taxRefundPaise;
  const lines: LedgerLine[] = completion
    ? [
        { account: "PROVIDER_PAYABLE", amountPaise: providerRefundPaise },
        { account: "TAX_PAYABLE", amountPaise: taxRefundPaise },
        { account: "PLATFORM_REVENUE", amountPaise: commissionRefundPaise },
      ]
    : [{ account: "CUSTOMER_FUNDS", amountPaise: input.amountPaise }];
  lines.push(
    { account: "GATEWAY_CLEARING", amountPaise: -gatewayPaise },
    { account: "WALLET_LIABILITY", amountPaise: -walletPaise },
  );
  return postLedgerBatch(tx, {
    reference: "refund:" + input.refundId,
    source: "REFUND_PROCESSED",
    bookingId: input.bookingId,
    providerId: input.providerId,
    staffId: input.staffId,
    actorId: input.actorId,
    lines,
  });
}

export async function lockFinanceProvider(tx: Tx, providerId: string) {
  await lockProvider(tx, providerId);
}

export { db };
