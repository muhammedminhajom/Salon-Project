import type { Booking, Payment, Prisma, Refund } from "@prisma/client";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { postLedgerBatch, recordRefund } from "@/lib/finance-ledger";
import { issueCreditNotes } from "@/lib/invoices";
import { releaseCouponUsage } from "@/lib/coupons";
import { restoreLoyaltyPoints } from "@/lib/rewards";
import { notifyBooking, scheduleBookingReminders } from "@/lib/notifications";
import { currency, maxStoredPaise, portion } from "@/lib/money";
import { lockProvider } from "@/lib/provider-lock";

type Tx = Prisma.TransactionClient;
type BookingMoney = Pick<Booking, "id" | "customerId" | "providerId" | "staffId" | "totalPaise">;

export const paymentSummary = {
  id: true,
  status: true,
  currency: true,
  gatewayAmountPaise: true,
  gatewayCapturedPaise: true,
  walletUsedPaise: true,
  refundedPaise: true,
  dueAtVenuePaise: true,
} satisfies Prisma.PaymentSelect;

export function moneyAudit(tx: Tx, action: string, targetId: string, amountPaise: number, actorId?: string) {
  return tx.auditLog.create({ data: { actorId, targetId, action, metadata: { amountPaise, currency } } });
}

export async function lockWallet(tx: Tx, userId: string) {
  await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  const [row] = await tx.$queryRaw<{ balancePaise: number }[]>`
    SELECT "balancePaise" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE
  `;
  return row.balancePaise;
}

export async function walletMovement(
  tx: Tx,
  userId: string,
  targetId: string,
  amountPaise: number,
  reference: string,
  actorId?: string,
  skipLedger = false,
) {
  if (amountPaise === 0) return;
  const balance = await lockWallet(tx, userId);
  if (await tx.walletEntry.findUnique({ where: { reference }, select: { id: true } })) return;
  const balancePaise = balance + amountPaise;
  if (balancePaise < 0) throw new HttpError(409, "The wallet balance changed.", "PRICE_CHANGED");
  if (balancePaise > maxStoredPaise)
    throw new HttpError(409, "This credit exceeds the wallet balance limit.");
  await tx.wallet.update({ where: { userId }, data: { balancePaise } });
  await tx.walletEntry.create({ data: { userId, reference, amountPaise, balancePaise } });
  if (!skipLedger) {
    await postLedgerBatch(tx, {
      reference: "wallet-movement:" + reference,
      source: amountPaise > 0 ? "WALLET_CREDIT" : "WALLET_SPEND",
      actorId,
      bookingId: targetId,
      lines: [
        { account: "WALLET_LIABILITY", amountPaise: -amountPaise },
        { account: "CUSTOMER_FUNDS", amountPaise },
      ],
    });
  }
  await moneyAudit(
    tx,
    amountPaise > 0 ? "WALLET_CREDITED" : "WALLET_DEBITED",
    targetId,
    amountPaise,
    actorId,
  );
}

export async function completeRefund(
  tx: Tx,
  booking: BookingMoney,
  payment: Payment,
  refund: Refund,
  now: Date,
  actorId?: string,
) {
  if (refund.status === "PROCESSED") return payment;
  const refundedPaise = payment.refundedPaise + refund.amountPaise;
  const collected = payment.gatewayCapturedPaise + payment.walletUsedPaise;
  if (refundedPaise > collected)
    throw new HttpError(409, "The refund exceeds the amount collected.", "REFUND_AMOUNT_INVALID");
  const credit = refund.destination === "WALLET" ? refund.amountPaise : refund.walletPaise;
  await walletMovement(tx, booking.customerId, booking.id, credit, "refund:" + refund.id, actorId, true);
  const items = await tx.bookingItem.findMany({
    where: { bookingId: booking.id },
    select: { pricePaise: true, commissionBps: true },
  });
  const commissionPaise = items.reduce(
    (sum, item) => sum + Math.round((item.pricePaise * item.commissionBps + 5000) / 10_000),
    0,
  );
  const commissionBps = booking.totalPaise
    ? Math.min(10_000, Math.round((commissionPaise * 10_000) / booking.totalPaise))
    : 0;
  await recordRefund(tx, {
    refundId: refund.id,
    bookingId: booking.id,
    providerId: booking.providerId,
    staffId: booking.staffId,
    amountPaise: refund.amountPaise,
    gatewayPaise: refund.gatewayPaise,
    walletCreditPaise: credit,
    commissionBps,
    destination: refund.destination,
    actorId,
  });
  await issueCreditNotes(
    tx,
    booking.id,
    refund.id,
    refund.amountPaise,
    portion(refund.amountPaise, commissionBps),
    now,
  );
  await tx.refund.update({
    where: { id: refund.id },
    data: { status: "PROCESSED", processedAt: now },
  });
  await moneyAudit(tx, "REFUND_PROCESSED", booking.id, refund.amountPaise, actorId);
  const updated = await tx.payment.update({
    where: { id: payment.id },
    data: { refundedPaise, status: refundedPaise === collected ? "REFUNDED" : "PARTIALLY_REFUNDED" },
  });
  await notifyBooking(tx, booking.id, {
    eventType: "REFUND_PROCESSED",
    title: "Refund processed",
    body: "Your refund was processed. Check your wallet or original payment method for the funds.",
    eventKey: refund.id,
  });
  return updated;
}

export async function cancelPaymentHold(tx: Tx, bookingId: string, now: Date, actorId?: string) {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { payment: true },
  });
  if (!booking.holdExpiresAt) return;
  await tx.booking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED", holdExpiresAt: null },
  });
  await releaseCouponUsage(tx, bookingId);
  await restoreLoyaltyPoints(tx, booking.customerId, bookingId);
  const payment = booking.payment;
  if (payment?.walletUsedPaise) {
    const refund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        requestKey: "hold-released",
        reason: "Payment hold released",
        destination: "WALLET",
        amountPaise: payment.walletUsedPaise,
        walletPaise: payment.walletUsedPaise,
        gatewayPaise: 0,
      },
    });
    await completeRefund(tx, booking, payment, refund, now, actorId);
  } else if (payment) {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
  }
  await moneyAudit(tx, "PAYMENT_HOLD_RELEASED", bookingId, 0, actorId);
  await notifyBooking(tx, bookingId, {
    eventType: "BOOKING_CANCELLED",
    title: "Payment hold ended",
    body: "The payment hold ended and the appointment slot was released.",
  });
  await scheduleBookingReminders(tx, bookingId);
}

export async function releaseProviderHolds(tx: Tx, providerId: string, now: Date) {
  const holds = await tx.booking.findMany({
    where: { providerId, holdExpiresAt: { lte: now } },
    select: { id: true },
  });
  for (const hold of holds) await cancelPaymentHold(tx, hold.id, now);
  return holds.length;
}

export async function expirePaymentHolds(now = new Date()) {
  const candidates = await db.booking.findMany({
    where: { holdExpiresAt: { lte: now } },
    orderBy: { holdExpiresAt: "asc" },
    select: { providerId: true },
    take: 100,
  });
  let released = 0;
  for (const providerId of new Set(candidates.map((candidate) => candidate.providerId))) {
    released += await db.$transaction(
      async (tx) => {
        await lockProvider(tx, providerId);
        return releaseProviderHolds(tx, providerId, now);
      },
      { timeout: 20_000 },
    );
  }
  return released;
}
