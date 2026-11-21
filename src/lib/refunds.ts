import type { Booking, Payment, Prisma, RefundDestination } from "@prisma/client";
import type { z } from "zod";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { completeRefund, moneyAudit } from "@/lib/payment-records";
import { applyGatewayRefund } from "@/lib/payments";
import { lockProvider } from "@/lib/provider-lock";
import { razorpay } from "@/lib/razorpay";
import type { adminRefundSchema } from "@/lib/schemas";
import { digest } from "@/lib/secrets";

type Tx = Prisma.TransactionClient;

export async function refundCapacity(tx: Tx, bookingId: string) {
  const payment = await tx.payment.findUnique({ where: { bookingId } });
  if (!payment) return { payment, availablePaise: 0, gatewayPaise: 0, walletPaise: 0 };
  const { _sum } = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: { not: "FAILED" } },
    _sum: { gatewayPaise: true, walletPaise: true },
  });
  const gatewayPaise = payment.gatewayCapturedPaise - (_sum.gatewayPaise ?? 0);
  const walletPaise = payment.walletUsedPaise - (_sum.walletPaise ?? 0);
  return { payment, gatewayPaise, walletPaise, availablePaise: gatewayPaise + walletPaise };
}

export async function requestRefund(
  tx: Tx,
  booking: Pick<Booking, "id" | "customerId" | "providerId" | "staffId" | "totalPaise">,
  funding: { payment: Payment | null; gatewayPaise: number; availablePaise: number },
  input: {
    amountPaise: number;
    requestKey: string;
    reason: string;
    destination: RefundDestination;
    actorId: string;
    requestHash?: string;
  },
  now: Date,
) {
  if (!funding.payment || input.amountPaise > funding.availablePaise)
    throw new HttpError(409, "The amount exceeds the remaining refundable balance.", "REFUND_AMOUNT_INVALID");
  const gatewayPaise = Math.min(funding.gatewayPaise, input.amountPaise);
  const refund = await tx.refund.create({
    data: {
      paymentId: funding.payment.id,
      requestKey: input.requestKey,
      requestHash: input.requestHash,
      reason: input.reason,
      destination: input.destination,
      amountPaise: input.amountPaise,
      gatewayPaise,
      walletPaise: input.amountPaise - gatewayPaise,
      nextAttemptAt: now,
    },
  });
  await moneyAudit(tx, "REFUND_REQUESTED", booking.id, refund.amountPaise, input.actorId);
  if (refund.destination === "WALLET" || !gatewayPaise) {
    await completeRefund(tx, booking, funding.payment, refund, now, input.actorId);
    return { ...refund, status: "PROCESSED" as const, processedAt: now };
  }
  return refund;
}

export async function overrideRefund(actorId: string, input: z.infer<typeof adminRefundSchema>) {
  const { requestKey, ...details } = input;
  const requestHash = digest(JSON.stringify(details));
  return db.$transaction(async (tx) => {
    const first = await tx.booking.findUnique({
      where: { id: input.bookingId },
      select: { providerId: true },
    });
    if (!first) throw new HttpError(404, "Booking not found.");
    await lockProvider(tx, first.providerId);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId } });
    const funding = await refundCapacity(tx, booking.id);
    if (!funding.payment) throw new HttpError(409, "This booking has no refundable payment.");
    const prior = await tx.refund.findUnique({
      where: { paymentId_requestKey: { paymentId: funding.payment.id, requestKey } },
    });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new HttpError(409, "This refund key was already used.");
      return prior;
    }
    if (booking.holdExpiresAt)
      throw new HttpError(409, "Release the payment hold before overriding a refund.");
    const refund = await requestRefund(tx, booking, funding, { ...input, actorId, requestHash }, new Date());
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: booking.id,
        action: "ADMIN_REFUND_OVERRIDE",
        metadata: { amountPaise: input.amountPaise, reason: input.reason, refundId: refund.id },
      },
    });
    return refund;
  });
}

export async function processDueRefunds(
  gateway: Pick<typeof razorpay, "refund" | "fetchRefund"> = razorpay,
  now = new Date(),
) {
  const pending = await db.refund.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: now },
      destination: "ORIGINAL",
      gatewayPaise: { gt: 0 },
    },
    take: 20,
    orderBy: { nextAttemptAt: "asc" },
    include: { payment: { include: { booking: true } } },
  });
  let processed = 0;
  for (const item of pending) {
    const paymentId = item.payment.gatewayPaymentId;
    if (!paymentId) continue;
    const { count } = await db.$transaction(async (tx) =>
      tx.refund.updateMany({
        where: { id: item.id, status: "PENDING", nextAttemptAt: { lte: now } },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(+now + 30_000 * 2 ** Math.min(item.attempts, 7)),
        },
      }),
    );
    if (!count) continue;
    const result = await (
      item.gatewayRefundId
        ? gateway.fetchRefund(paymentId, item.gatewayRefundId)
        : gateway.refund(paymentId, item.id, item.gatewayPaise)
    ).catch(() => undefined);
    if (!result || result.payment_id !== paymentId || result.amount !== item.gatewayPaise) continue;
    processed += await db.$transaction(async (tx) => {
      await lockProvider(tx, item.payment.booking.providerId);
      const current = await tx.refund.findUniqueOrThrow({ where: { id: item.id } });
      if (current.status !== "PENDING" || (current.gatewayRefundId && current.gatewayRefundId !== result.id))
        return 0;
      await tx.refund.update({
        where: { id: item.id },
        data: { gatewayRefundId: result.id, status: result.status === "failed" ? "FAILED" : "PENDING" },
      });
      if (result.status === "failed")
        await moneyAudit(tx, "REFUND_FAILED", item.payment.bookingId, item.amountPaise);
      if (result.status !== "processed") return 0;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: item.paymentId },
        include: { booking: true },
      });
      await applyGatewayRefund(tx, payment, result, now);
      return 1;
    });
  }
  return processed;
}
