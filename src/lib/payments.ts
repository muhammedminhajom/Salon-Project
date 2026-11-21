import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordGatewayCapture } from "@/lib/finance-ledger";
import { notifyBooking, scheduleBookingReminders } from "@/lib/notifications";
import { HttpError } from "@/lib/http";
import { cancelPaymentHold, completeRefund, moneyAudit } from "@/lib/payment-records";
import { lockProvider } from "@/lib/provider-lock";
import { razorpay, validGatewaySignature, type GatewayPayment, type GatewayRefund } from "@/lib/razorpay";
import { gatewayEventSchema, gatewayId, razorpayPaymentSchema, razorpayRefundSchema } from "@/lib/schemas";
import { digest } from "@/lib/secrets";

type Tx = Prisma.TransactionClient;
type Payment = Prisma.PaymentGetPayload<{ include: { booking: true } }>;
type PaymentEvent =
  | { type: "payment.captured" | "payment.failed"; payment: GatewayPayment }
  | { type: "refund.processed"; refund: GatewayRefund };

const holdExpired = () =>
  new HttpError(409, "This payment hold has ended. Choose a new time.", "HOLD_EXPIRED");
const entity = <T>(schema: z.ZodType<T>) => z.object({ entity: schema });

function eventFromBody(body: Buffer): PaymentEvent | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid webhook body.");
  }
  const event = gatewayEventSchema.parse(payload);
  if (event.event === "payment.captured" || event.event === "payment.failed") {
    return {
      type: event.event,
      payment: z.object({ payment: entity(razorpayPaymentSchema) }).parse(event.payload).payment.entity,
    };
  }
  if (event.event === "refund.processed") {
    return {
      type: event.event,
      refund: z.object({ refund: entity(razorpayRefundSchema) }).parse(event.payload).refund.entity,
    };
  }
}

async function ownedPayment(bookingId: string, customerId: string) {
  const payment = await db.payment.findFirst({
    where: { bookingId, booking: { customerId } },
    include: { booking: true },
  });
  if (!payment) throw new HttpError(404, "Payment not found.");
  return payment;
}

async function withLockedPayment<T>(payment: Payment, action: (tx: Tx, latest: Payment) => Promise<T>) {
  return db.$transaction(async (tx) => {
    await lockProvider(tx, payment.booking.providerId);
    const latest = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { booking: true },
    });
    return action(tx, latest);
  });
}

export async function createGatewayOrder(
  bookingId: string,
  customerId: string,
  gateway: Pick<typeof razorpay, "findOrder" | "createOrder"> = razorpay,
  now = new Date(),
) {
  const payment = await ownedPayment(bookingId, customerId);
  const reserved = await withLockedPayment(payment, async (tx, latest) => {
    if (!latest.gatewayAmountPaise) throw new HttpError(409, "No online payment is due for this booking.");
    if (!latest.booking.holdExpiresAt || latest.booking.holdExpiresAt <= now) throw holdExpired();
    if (latest.gatewayOrderId) return latest;
    if (latest.orderClaimedAt && +now - +latest.orderClaimedAt < 30_000)
      throw new HttpError(409, "Checkout is being prepared. Try again shortly.", "ORDER_IN_PROGRESS");
    return tx.payment.update({
      where: { id: latest.id },
      data: { orderClaimedAt: now, status: "PENDING" },
      include: { booking: true },
    });
  });
  if (reserved.gatewayOrderId)
    return {
      orderId: reserved.gatewayOrderId,
      amount: reserved.gatewayAmountPaise,
      currency: reserved.currency,
    };
  const order =
    (await gateway.findOrder(reserved.id)) ??
    (await gateway.createOrder(reserved.id, reserved.gatewayAmountPaise));
  if (
    order.receipt !== reserved.id ||
    order.amount !== reserved.gatewayAmountPaise ||
    order.currency !== reserved.currency
  )
    throw new HttpError(502, "The gateway order does not match this checkout.");
  await withLockedPayment(reserved, async (tx, latest) => {
    if (latest.gatewayOrderId && latest.gatewayOrderId !== order.id)
      throw new HttpError(409, "Multiple gateway orders need reconciliation.");
    if (!latest.gatewayOrderId) {
      await tx.payment.update({
        where: { id: latest.id },
        data: { gatewayOrderId: order.id, orderClaimedAt: null },
      });
      await moneyAudit(tx, "GATEWAY_ORDER_LINKED", latest.bookingId, latest.gatewayAmountPaise, customerId);
    }
  });
  return { orderId: order.id, amount: order.amount, currency: order.currency };
}

function assertIncomingPayment(payment: Payment, incoming: GatewayPayment) {
  if (
    payment.gatewayOrderId !== incoming.order_id ||
    payment.gatewayAmountPaise !== incoming.amount ||
    payment.currency !== incoming.currency
  ) {
    throw new HttpError(409, "Payment details do not match the booking.", "PAYMENT_MISMATCH");
  }
}

async function capture(tx: Tx, payment: Payment, incoming: GatewayPayment, now: Date, actorId?: string) {
  assertIncomingPayment(payment, incoming);
  if (payment.gatewayPaymentId) {
    if (payment.gatewayPaymentId !== incoming.id)
      throw new HttpError(409, "Another payment is linked to this booking.");
    return payment;
  }
  const { booking } = payment;
  const expired = Boolean(booking.holdExpiresAt && booking.holdExpiresAt <= now);
  if (expired) {
    await cancelPaymentHold(tx, booking.id, now);
  } else if (booking.holdExpiresAt) {
    await tx.booking.update({
      where: { id: booking.id },
      data: { holdExpiresAt: null, status: booking.confirmAfterPayment ? "CONFIRMED" : "PENDING" },
    });
  }
  await moneyAudit(tx, "PAYMENT_CAPTURED", booking.id, incoming.amount, actorId);
  const captured = await tx.payment.update({
    where: { id: payment.id },
    data: {
      gatewayCapturedPaise: incoming.amount,
      gatewayPaymentId: incoming.id,
      gatewayFeePaise: incoming.fee ?? 0,
      status: "CAPTURED",
      lateCapture: expired || booking.status === "CANCELLED",
    },
    include: { booking: true },
  });
  await recordGatewayCapture(tx, {
    paymentId: captured.id,
    bookingId: booking.id,
    providerId: booking.providerId,
    staffId: booking.staffId,
    amountPaise: incoming.amount,
    actorId,
  });
  await notifyBooking(tx, booking.id, {
    eventType: "PAYMENT_SUCCESS",
    title: "Payment received",
    body: "Your online payment has been received and your booking is updated.",
  });
  await scheduleBookingReminders(tx, booking.id);
  return captured;
}

async function refundLateCapture(tx: Tx, payment: Payment, now: Date) {
  if (!payment.lateCapture || !payment.gatewayCapturedPaise) return;
  const allocated = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: { not: "FAILED" } },
    _sum: { gatewayPaise: true },
  });
  const amount = payment.gatewayCapturedPaise - (allocated._sum.gatewayPaise ?? 0);
  if (amount <= 0) return;
  const refund = await tx.refund.create({
    data: {
      paymentId: payment.id,
      requestKey: "late-capture",
      destination: "WALLET",
      reason: "Payment arrived after the hold was released",
      amountPaise: amount,
      gatewayPaise: amount,
      walletPaise: 0,
    },
  });
  await completeRefund(tx, payment.booking, payment, refund, now);
}

export async function verifyGatewayPayment(
  customerId: string,
  input: { bookingId: string; orderId: string; paymentId: string; signature: string },
  gateway: Pick<typeof razorpay, "fetchPayment"> = razorpay,
  secret = process.env.RAZORPAY_KEY_SECRET,
  now = new Date(),
) {
  const payment = await ownedPayment(input.bookingId, customerId);
  if (
    !secret ||
    !payment.gatewayOrderId ||
    payment.gatewayOrderId !== input.orderId ||
    !validGatewaySignature(payment.gatewayOrderId + "|" + input.paymentId, input.signature, secret)
  )
    throw new HttpError(400, "Payment signature could not be verified.", "INVALID_SIGNATURE");
  if (payment.gatewayPaymentId && payment.gatewayPaymentId === input.paymentId)
    return { status: payment.status, bookingStatus: payment.booking.status };
  const incoming = await gateway.fetchPayment(input.paymentId);
  assertIncomingPayment(payment, incoming);
  if (incoming.id !== input.paymentId) throw new HttpError(409, "Gateway payment ID does not match.");
  if (incoming.status !== "captured") return { status: "PENDING", bookingStatus: payment.booking.status };
  return withLockedPayment(payment, async (tx, latest) => {
    const accepted = await capture(tx, latest, incoming, now, customerId);
    await refundLateCapture(tx, accepted, now);
    const current = await tx.payment.findUniqueOrThrow({
      where: { id: accepted.id },
      include: { booking: true },
    });
    return { status: current.status, bookingStatus: current.booking.status };
  });
}

export async function applyGatewayRefund(tx: Tx, payment: Payment, incoming: GatewayRefund, now: Date) {
  const match = await tx.refund.findFirst({
    where: {
      paymentId: payment.id,
      OR: [
        { gatewayRefundId: incoming.id },
        ...(incoming.notes?.refund_id ? [{ id: incoming.notes.refund_id }] : []),
      ],
    },
  });
  if (match) {
    if (
      match.destination !== "ORIGINAL" ||
      match.gatewayPaise !== incoming.amount ||
      (match.gatewayRefundId && match.gatewayRefundId !== incoming.id)
    )
      throw new HttpError(409, "Gateway refund differs from the approved request.");
    const refund = await tx.refund.update({
      where: { id: match.id },
      data: { gatewayRefundId: incoming.id },
    });
    await completeRefund(tx, payment.booking, payment, refund, now);
    return true;
  }
  const allocated = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: { not: "FAILED" } },
    _sum: { gatewayPaise: true },
  });
  if (payment.gatewayCapturedPaise - (allocated._sum.gatewayPaise ?? 0) < incoming.amount) {
    await moneyAudit(tx, "GATEWAY_REFUND_NEEDS_RECONCILIATION", payment.bookingId, incoming.amount);
    return false;
  }
  const refund = await tx.refund.create({
    data: {
      paymentId: payment.id,
      requestKey: incoming.id,
      destination: "ORIGINAL",
      reason: "Razorpay refund",
      amountPaise: incoming.amount,
      gatewayPaise: incoming.amount,
      walletPaise: 0,
      gatewayRefundId: incoming.id,
    },
  });
  await completeRefund(tx, payment.booking, payment, refund, now);
  return true;
}

export async function receiveGatewayWebhook(
  body: Buffer,
  signature: string,
  eventId: string,
  gateway: Pick<typeof razorpay, "fetchPayment"> = razorpay,
  secret = process.env.RAZORPAY_WEBHOOK_SECRET,
  now = new Date(),
) {
  if (!secret || !validGatewaySignature(body, signature, secret))
    throw new HttpError(401, "Invalid webhook signature.");
  if (!gatewayId.safeParse(eventId).success) throw new HttpError(400, "A gateway event ID is required.");
  const event = eventFromBody(body);
  if (!event) return { received: true, duplicate: false };
  const fingerprint = digest(body.toString("utf8"));
  const replay = await db.gatewayEvent.findUnique({ where: { id: eventId } });
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new HttpError(409, "Webhook event ID was reused.");
    return { received: true, duplicate: true };
  }
  const find = (where: Prisma.PaymentWhereUniqueInput) =>
    db.payment.findUnique({ where, include: { booking: true } });
  let observed: GatewayPayment | undefined;
  let payment =
    "refund" in event
      ? await find({ gatewayPaymentId: event.refund.payment_id })
      : await find({ gatewayOrderId: event.payment.order_id });
  if (!payment && "refund" in event) {
    observed = await gateway.fetchPayment(event.refund.payment_id);
    if (observed.id !== event.refund.payment_id || !["captured", "refunded"].includes(observed.status))
      throw new HttpError(409, "The gateway has not confirmed the refunded payment.");
    payment = await find({ gatewayOrderId: observed.order_id });
  }
  if (!payment) return { received: true, duplicate: false };
  return withLockedPayment(payment, async (tx, latest) => {
    const { count } = await tx.gatewayEvent.createMany({
      data: {
        id: eventId,
        fingerprint,
        type: event.type,
        gatewayPaymentId: "refund" in event ? event.refund.payment_id : event.payment.id,
        gatewayRefundId: "refund" in event ? event.refund.id : undefined,
        amountPaise: "refund" in event ? event.refund.amount : event.payment.amount,
      },
      skipDuplicates: true,
    });
    if (!count) {
      const stored = await tx.gatewayEvent.findUniqueOrThrow({ where: { id: eventId } });
      if (stored.fingerprint !== fingerprint) throw new HttpError(409, "Webhook event ID was reused.");
      return { received: true, duplicate: true };
    }
    let applied = true;
    if ("refund" in event) {
      if (event.refund.status !== "processed") throw new HttpError(409, "Refund has not been processed.");
      let captured = observed && !latest.gatewayPaymentId ? await capture(tx, latest, observed, now) : latest;
      if (captured.gatewayPaymentId !== event.refund.payment_id)
        throw new HttpError(409, "Refund payment ID does not match.");
      applied = await applyGatewayRefund(tx, captured, event.refund, now);
      captured = await tx.payment.findUniqueOrThrow({
        where: { id: captured.id },
        include: { booking: true },
      });
      await refundLateCapture(tx, captured, now);
    } else if (event.type === "payment.captured") {
      if (event.payment.status !== "captured") throw new HttpError(409, "Payment has not been captured.");
      const captured = await capture(tx, latest, event.payment, now);
      await refundLateCapture(tx, captured, now);
    } else {
      assertIncomingPayment(latest, event.payment);
      if (!latest.gatewayPaymentId && latest.booking.holdExpiresAt && latest.status !== "FAILED") {
        await tx.payment.update({ where: { id: latest.id }, data: { status: "FAILED" } });
        await moneyAudit(tx, "PAYMENT_FAILED", latest.bookingId, 0);
        await notifyBooking(tx, latest.bookingId, {
          eventType: "PAYMENT_FAILURE",
          title: "Payment did not complete",
          body: "The payment did not complete. Reopen your booking to choose another time or try again.",
        });
      }
    }
    if (applied) await tx.gatewayEvent.update({ where: { id: eventId }, data: { appliedAt: now } });
    return { received: true, duplicate: false };
  });
}
