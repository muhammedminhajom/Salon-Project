import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const id = z.string().min(1).max(100);
export const text = (max: number) => z.string().trim().max(max);
export const requiredText = (max: number) => text(max).min(1);
export const whole = (min: number, max: number) => z.number().int().min(min).max(max);
export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);
export const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const password = z.string().min(10).max(200);
export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Use the international format, for example +919876543210.");
export const providerType = z.enum(["SHOP", "ARTIST"]);
export const instant = z.iso.datetime({ offset: true });
export const timeZone = z.string().refine((value) => {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    Temporal.Now.zonedDateTimeISO(value);
    return true;
  } catch {
    return false;
  }
}, "Enter an IANA time zone such as Asia/Kolkata.");
export const imageUrl = z
  .string()
  .max(500)
  .refine(
    (value) =>
      /^\/images\/[a-z0-9_-]+\.webp$/.test(value) || z.url({ protocol: /^https$/ }).safeParse(value).success,
    "Use an HTTPS image URL.",
  );
export const signUpSchema = z
  .object({
    name: requiredText(80),
    email,
    password,
    type: providerType.optional(),
    referralCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{4,24}$/)
      .optional(),
  })
  .refine((input) => !input.type || !input.referralCode, "Referral codes are for customer accounts.");
export const signInSchema = z.object({ email, password: z.string().min(1).max(200) });
export const passwordResetRequestSchema = z.object({ email });
export const passwordResetCompleteSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password,
});
export const otpSendSchema = z.object({
  phone,
  name: requiredText(80).optional(),
  type: providerType.optional(),
});
export const otpCheckSchema = z.object({ challenge: id, code: z.string().regex(/^\d{4,8}$/) });

export const selectionSchema = z.object({
  providerId: id,
  branchId: id,
  serviceIds: z
    .array(id)
    .min(1)
    .max(8)
    .refine((values) => new Set(values).size === values.length, "Choose each service once."),
  staffId: id.optional(),
  mode: z.enum(["VENUE", "HOME"]).default("VENUE"),
  location: z.object({ address: requiredText(500).optional(), latitude, longitude }).optional(),
});

export const availabilitySchema = selectionSchema.extend({ date: z.iso.date() });
export const paymentModeSchema = z.enum(["FULL_ONLINE", "DEPOSIT", "PAY_AT_VENUE"]);
const checkoutOptions = {
  paymentMode: paymentModeSchema.optional(),
  useWallet: z.boolean().optional(),
  couponCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,40}$/)
    .optional(),
  loyaltyPoints: whole(0, 100_000).optional(),
};
export const checkoutQuoteSchema = selectionSchema.extend(checkoutOptions);
export const bookingSchema = selectionSchema.extend({
  ...checkoutOptions,
  startsAt: instant,
  requestKey: z.uuid(),
  expectedTotalPaise: whole(0, 100_000_000).optional(),
  expectedWalletPaise: whole(0, 100_000_000).optional(),
});
export const gatewayId = z.string().regex(/^[A-Za-z0-9_-]{3,80}$/);
export const gatewaySignature = z.string().regex(/^[a-fA-F0-9]{64}$/);
export const paymentActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), selection: checkoutQuoteSchema }),
  z.object({ action: z.literal("order"), bookingId: id }),
  z.object({
    action: z.literal("verify"),
    bookingId: id,
    orderId: gatewayId,
    paymentId: gatewayId,
    signature: gatewaySignature,
  }),
]);
export const paymentSettingsSchema = z.discriminatedUnion("gstRegistered", [
  z.object({ gstRegistered: z.literal(false), depositBps: whole(100, 9900).nullable() }),
  z.object({
    gstRegistered: z.literal(true),
    depositBps: whole(100, 9900).nullable(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/),
    gstRateBps: whole(0, 10_000),
  }),
]);
export const payoutDetailsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("UPI"),
    upiId: z
      .string()
      .trim()
      .max(120)
      .regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/),
  }),
  z.object({
    type: z.literal("BANK"),
    accountHolderName: requiredText(100),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  }),
]);
export const payoutRequestSchema = z.object({
  requestKey: z.uuid(),
  amountPaise: whole(50_000, 2_147_483_647),
});
export const payoutActionSchema = z
  .object({
    payoutIds: z.array(id).min(1).max(50),
    action: z.enum(["APPROVE", "REJECT", "MARK_PAID", "RETRY"]),
    reference: text(120).optional(),
    reason: text(500).optional(),
  })
  .refine(
    (input) => input.action !== "MARK_PAID" || Boolean(input.reference),
    "A payment reference is required.",
  )
  .refine(
    (input) => !["REJECT"].includes(input.action) || Boolean(input.reason),
    "A rejection reason is required.",
  );
export const commissionSettingsSchema = z.object({
  defaultCommissionBps: whole(0, 10_000),
  minimumPayoutPaise: whole(50_000, 2_147_483_647),
  payoutCycleDays: whole(1, 31),
  loyaltyPointsPerVisit: whole(0, 100_000),
  loyaltyPaisePerPoint: whole(1, 100_000),
  loyaltyExpiryDays: whole(30, 3650),
  referralRewardPaise: whole(0, 2_147_483_647),
});
export const commissionOverrideSchema = z.object({
  scope: z.enum(["CATEGORY", "PROVIDER"]),
  id,
  commissionBps: whole(0, 10_000).nullable(),
});
export const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,40}$/),
    kind: z.enum(["PERCENT", "FLAT", "FIRST_BOOKING", "CATEGORY", "PROVIDER"]),
    discountType: z.enum(["PERCENT", "FLAT"]),
    funding: z.enum(["PLATFORM", "PROVIDER"]),
    amount: whole(1, 2_147_483_647),
    maxDiscountPaise: whole(1, 2_147_483_647).nullable(),
    minCartPaise: whole(0, 2_147_483_647),
    totalUses: whole(1, 2_147_483_647).nullable(),
    perUserLimit: whole(1, 1000),
    validFrom: instant,
    validUntil: instant,
    categoryId: id.nullable(),
    providerId: id.nullable(),
    active: z.boolean(),
  })
  .refine((input) => input.validUntil > input.validFrom, "The coupon must end after it starts.")
  .refine(
    (input) => input.discountType !== "PERCENT" || input.amount <= 10_000,
    "Percent discounts use basis points from 1 to 10000.",
  )
  .refine((input) => input.kind !== "CATEGORY" || Boolean(input.categoryId), "Choose a category.")
  .refine((input) => input.kind !== "PROVIDER" || Boolean(input.providerId), "Choose a provider.");
export const couponToggleSchema = z.object({ id, active: z.boolean() });
export const reviewSchema = z.object({
  bookingId: id,
  rating: whole(1, 5),
  body: text(1000),
});
export const reviewReplySchema = z.object({ reply: requiredText(1000) });
export const reviewReportSchema = z.object({ reason: requiredText(500).min(10) });
export const reviewModerationSchema = z.object({
  status: z.enum(["PUBLISHED", "HIDDEN", "DELETED"]),
  reason: requiredText(500).min(10),
});
export const notificationEventSchema = z.enum([
  "BOOKING_CREATED",
  "BOOKING_CONFIRMED",
  "BOOKING_RESCHEDULED",
  "BOOKING_CANCELLED",
  "BOOKING_COMPLETED",
  "BOOKING_NO_SHOW",
  "BOOKING_REMINDER",
  "REVIEW_PROMPT",
  "REVIEW_RECEIVED",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILURE",
  "REFUND_PROCESSED",
  "PAYOUT_PAID",
  "COUPON_OFFER",
]);
export const notificationPreferenceSchema = z.object({
  preferences: z
    .array(
      z.object({
        eventType: notificationEventSchema,
        channel: z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]),
        enabled: z.boolean(),
      }),
    )
    .max(100),
});
export const notificationTemplateSchema = z.object({
  eventType: notificationEventSchema,
  channel: z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]),
  subject: text(200),
  body: requiredText(5000),
  enabled: z.boolean(),
});
export const notificationReadSchema = z.object({ ids: z.array(id).min(1).max(50) });
export const cancellationPolicySchema = z
  .object({
    freeRefundHours: whole(0, 168),
    noRefundHours: whole(0, 168),
    cancellationFeeBps: whole(0, 10_000),
    noShowFeeBps: whole(0, 10_000),
  })
  .refine(
    (input) => input.noRefundHours <= input.freeRefundHours,
    "The no-refund window must fit within the cancellation window.",
  );
export const refundDestination = z.enum(["ORIGINAL", "WALLET"]);
export const cancelAppointmentSchema = z.object({
  requestKey: z.uuid(),
  destination: refundDestination,
  expectedRefundPaise: whole(0, 100_000_000),
});
export const adminRefundSchema = z.object({
  bookingId: id,
  requestKey: z.uuid(),
  amountPaise: whole(1, 100_000_000),
  destination: refundDestination,
  reason: text(500).min(10),
});
export const razorpayPaymentSchema = z.object({
  id: gatewayId,
  order_id: gatewayId,
  amount: whole(1, 100_000_000),
  currency: z.literal("INR"),
  status: z.string(),
  fee: whole(0, 100_000_000).nullable().optional(),
});
export const razorpayRefundSchema = z.object({
  id: gatewayId,
  payment_id: gatewayId,
  amount: whole(1, 100_000_000),
  currency: z.literal("INR"),
  status: z.string(),
  notes: z.object({ refund_id: z.uuid().optional() }).nullish().catch(undefined),
});
export const gatewayEventSchema = z.object({ event: requiredText(100), payload: z.unknown() });
export const walkInSchema = selectionSchema
  .pick({ providerId: true, branchId: true, serviceIds: true, staffId: true })
  .extend({ customerName: requiredText(80), requestKey: z.uuid() });
export const rescheduleSchema = z
  .object({
    startsAt: instant,
    staffId: id.optional(),
    requestKey: z.uuid().optional(),
    expectedTotalPaise: whole(0, 100_000_000).optional(),
  })
  .refine(
    (input) => (input.expectedTotalPaise === undefined) === (input.requestKey === undefined),
    "A revised-price reschedule requires an expected price and a request key.",
  );
export const bookingStatusSchema = z.object({
  status: z.enum(["CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]),
});
