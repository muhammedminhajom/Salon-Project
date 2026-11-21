import { Temporal } from "@js-temporal/polyfill";
import { Prisma, type BookingStatus } from "@prisma/client";
import type { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { cancellationQuote } from "@/lib/cancellation";
import { db } from "@/lib/db";
import { recordBookingCompletion, resolveCommissionBps } from "@/lib/finance-ledger";
import { issueBookingInvoices } from "@/lib/invoices";
import { lockCoupon, quoteCoupon, reserveCouponUsage } from "@/lib/coupons";
import {
  completePhaseTwoRewards,
  getLoyaltyPoints,
  restoreLoyaltyPoints,
  spendLoyaltyPoints,
} from "@/lib/rewards";
import { completeCouponUsage, releaseCouponUsage } from "@/lib/coupons";
import { enqueueEvent, notifyBooking, scheduleBookingReminders } from "@/lib/notifications";
import { HttpError } from "@/lib/http";
import { portion, priceCheckout } from "@/lib/money";
import {
  cancelPaymentHold,
  lockWallet,
  moneyAudit,
  paymentSummary,
  releaseProviderHolds,
  walletMovement,
} from "@/lib/payment-records";
import { lockProvider } from "@/lib/provider-lock";
import { refundCapacity, requestRefund } from "@/lib/refunds";
import {
  canReserve,
  daySchedule,
  kmBetween,
  localDate,
  MINUTE,
  OCCUPIED,
  openTimes,
  reservation,
} from "@/lib/schedule";
import type {
  availabilitySchema,
  bookingSchema,
  cancelAppointmentSchema,
  checkoutQuoteSchema,
  rescheduleSchema,
  selectionSchema,
  walkInSchema,
} from "@/lib/schemas";
import { digest } from "@/lib/secrets";

type Tx = Prisma.TransactionClient;
type Selection = z.infer<typeof selectionSchema>;
type BookingInput = z.infer<typeof bookingSchema>;
type CheckoutSelection = z.infer<typeof checkoutQuoteSchema>;
type RescheduleInput = z.infer<typeof rescheduleSchema>;
type WalkInInput = z.infer<typeof walkInSchema>;
const bookingInclude = {
  items: { orderBy: { position: "asc" } },
  provider: { select: { displayName: true, slug: true, type: true } },
  staff: { select: { name: true } },
  branch: { select: { name: true, address: true } },
  payment: { select: paymentSummary },
  invoices: { select: { id: true, invoiceNumber: true, kind: true, issuedAt: true } },
  review: { select: { id: true, rating: true, body: true, editUntil: true, status: true } },
} as const satisfies Prisma.BookingInclude;
export type BookingDetails = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

async function bookableLocation(tx: Tx, providerId: string, branchId: string) {
  const provider = await tx.providerProfile.findFirst({ where: { id: providerId, status: "APPROVED" } });
  if (!provider) throw new HttpError(404, "This provider is currently unavailable.");
  const branch = await tx.branch.findFirst({ where: { id: branchId, providerId, active: true } });
  if (!branch) throw new HttpError(404, "This branch is currently unavailable.");
  return { provider, branch };
}

function eligibleStaff(
  tx: Tx,
  input: Pick<Selection, "providerId" | "branchId" | "staffId" | "serviceIds" | "mode">,
  incumbentId?: string,
) {
  const currentService = incumbentId
    ? { active: true, ...(input.mode === "HOME" ? { homeEligible: true } : {}) }
    : undefined;
  const assignments = input.serviceIds.map((serviceId) => ({
    services: { some: { serviceId, service: currentService } },
  }));
  return tx.staff.findMany({
    where: {
      providerId: input.providerId,
      branchId: input.branchId,
      active: true,
      id: input.staffId,
      ...(incumbentId ? { OR: [{ id: incumbentId }, { AND: assignments }] } : { AND: assignments }),
    },
    orderBy: { id: "asc" },
    include: { windows: true },
  });
}

async function prepare(tx: Tx, input: Selection) {
  const { provider, branch } = await bookableLocation(tx, input.providerId, input.branchId);
  if (input.mode === "VENUE" && provider.type === "ARTIST")
    throw new HttpError(400, "Choose a home visit for this artist.");
  const found = await tx.service.findMany({
    where: { id: { in: input.serviceIds }, providerId: provider.id, active: true },
    include: { category: { select: { commissionBps: true } } },
  });
  const services = input.serviceIds.map((id) => found.find((service) => service.id === id));
  if (!services.every((service) => service !== undefined))
    throw new HttpError(400, "One or more services are no longer offered.");
  if (services.every((service) => service.kind === "ADD_ON"))
    throw new HttpError(400, "Choose a service or package with your add-ons.");
  const staff = await eligibleStaff(tx, input);
  let travelPaise = 0;
  let travel = 0;
  if (input.mode === "HOME") {
    if (!provider.homeEnabled || services.some((service) => !service.homeEligible))
      throw new HttpError(400, "Home visits are unavailable for this selection.");
    if (!input.location || branch.latitude === null || branch.longitude === null)
      throw new HttpError(400, "Set a home-visit location to check availability.");
    const distance = kmBetween({ latitude: branch.latitude, longitude: branch.longitude }, input.location);
    if (distance > provider.travelRadiusKm)
      throw new HttpError(400, "This address is outside the provider’s travel area.");
    travelPaise = provider.travelBasePaise + Math.ceil(distance * provider.travelPerKmPaise);
    travel = Math.ceil(distance * provider.travelMinutesPerKm);
  }

  const settings = await tx.financeSetting.findUnique({
    where: { id: "platform" },
    select: {
      defaultCommissionBps: true,
      loyaltyPointsPerVisit: true,
      loyaltyPaisePerPoint: true,
      loyaltyExpiryDays: true,
    },
  });
  return {
    provider,
    branch,
    services,
    staff,
    travel,
    travelPaise,
    defaultCommissionBps: settings?.defaultCommissionBps ?? 1000,
    loyaltyPointsPerVisit: settings?.loyaltyPointsPerVisit ?? 10,
    loyaltyPaisePerPoint: settings?.loyaltyPaisePerPoint ?? 100,
    loyaltyExpiryDays: settings?.loyaltyExpiryDays ?? 365,
  };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;
type ScheduleContext = Pick<Prepared, "branch" | "staff" | "travel">;
type Length = { duration: number; buffer: number };

function checkoutPrice(
  context: Prepared,
  paymentMode: CheckoutSelection["paymentMode"] = "PAY_AT_VENUE",
  availableWalletPaise = 0,
  discountPaise = 0,
) {
  return priceCheckout({
    servicePaise: context.services.reduce((sum, service) => sum + service.pricePaise, 0),
    travelPaise: context.travelPaise,
    taxRateBps: context.provider.gstRegistered ? context.provider.gstRateBps : 0,
    depositBps: context.provider.depositBps,
    paymentMode,
    availableWalletPaise,
    discountPaise,
  });
}

async function checkoutDiscounts(
  tx: Tx,
  customerId: string,
  input: CheckoutSelection,
  context: Prepared,
  now: Date,
) {
  const serviceSubtotalPaise = context.services.reduce((sum, service) => sum + service.pricePaise, 0);
  const coupon = await quoteCoupon(tx, {
    customerId,
    code: input.couponCode,
    providerId: context.provider.id,
    categoryIds: context.services.map((service) => service.categoryId),
    serviceSubtotalPaise,
    cartSubtotalPaise: serviceSubtotalPaise + context.travelPaise,
    now,
  });
  const loyaltyPointsAvailable = await getLoyaltyPoints(tx, customerId, now);
  const loyaltyPoints = input.loyaltyPoints ?? 0;
  if (loyaltyPoints > loyaltyPointsAvailable)
    throw new HttpError(409, "Your loyalty points changed. Review the updated checkout.", "PRICE_CHANGED");
  const loyaltyDiscountPaise = loyaltyPoints * context.loyaltyPaisePerPoint;
  if (loyaltyDiscountPaise > serviceSubtotalPaise - coupon.discountPaise)
    throw new HttpError(400, "Use fewer loyalty points for this booking.");
  return {
    coupon: coupon.coupon,
    couponDiscountPaise: coupon.discountPaise,
    loyaltyPointsAvailable,
    loyaltyPoints,
    loyaltyDiscountPaise,
    discountPaise: coupon.discountPaise + loyaltyDiscountPaise,
  };
}

export async function getCheckoutQuote(customerId: string, input: CheckoutSelection) {
  return db.$transaction(async (tx) => {
    const context = await prepare(tx, input);
    const wallet = await tx.wallet.findUnique({ where: { userId: customerId } });
    const balancePaise = wallet?.balancePaise ?? 0;
    const discounts = await checkoutDiscounts(tx, customerId, input, context, new Date());
    return {
      ...checkoutPrice(
        context,
        input.paymentMode,
        input.useWallet ? balancePaise : 0,
        discounts.discountPaise,
      ),
      balancePaise,
      couponDiscountPaise: discounts.couponDiscountPaise,
      couponFunding: discounts.coupon?.funding ?? null,
      loyaltyPointsAvailable: discounts.loyaltyPointsAvailable,
      loyaltyDiscountPaise: discounts.loyaltyDiscountPaise,
    };
  });
}

function lengthOf(items: Length[]) {
  const last = items.at(-1)!;
  return {
    duration: items.reduce((sum, item) => sum + item.duration + item.buffer, 0) - last.buffer,
    buffer: last.buffer,
  };
}

function dateRange(date: string, zone: string, now: number) {
  const today = Temporal.PlainDate.from(localDate(now, zone));
  if (date < today.toString() || date > today.add({ days: 60 }).toString())
    throw new HttpError(400, "Choose a date within the next 60 days.");
}

async function staffSchedules(tx: Tx, context: ScheduleContext, date: string, now: number, ignore?: string) {
  dateRange(date, context.branch.timeZone, now);
  if (!context.staff.length) return [];
  const holiday = await tx.branchHoliday.findUnique({
    where: { branchId_date: { branchId: context.branch.id, date } },
    select: { date: true },
  });
  if (holiday) return [];
  const { start, end } = daySchedule(date, context.branch.timeZone, []);
  const staffIds = context.staff.map(({ id }) => id);
  const [reservations, timeOff] = await Promise.all([
    tx.booking.findMany({
      where: {
        staffId: { in: staffIds },
        id: ignore ? { not: ignore } : undefined,
        status: { in: [...OCCUPIED] },
        OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: new Date(now) } }],
        reservedFrom: { lt: new Date(end) },
        reservedUntil: { gt: new Date(start) },
      },
    }),
    tx.timeOff.findMany({
      where: { staffId: { in: staffIds }, startsAt: { lt: new Date(end) }, endsAt: { gt: new Date(start) } },
    }),
  ]);
  return context.staff.map((staff) => {
    const { work, breaks } = daySchedule(date, context.branch.timeZone, staff.windows);
    const blocked = [
      ...breaks,
      ...reservations
        .filter((item) => item.staffId === staff.id)
        .map((item) => ({ start: +item.reservedFrom, end: +item.reservedUntil })),
      ...timeOff
        .filter((item) => item.staffId === staff.id)
        .map((item) => ({ start: +item.startsAt, end: +item.endsAt })),
    ];
    return { staff, work, blocked };
  });
}

async function staffTimes(
  tx: Tx,
  context: ScheduleContext,
  date: string,
  length: Length,
  now: number,
  ignore?: string,
) {
  return (await staffSchedules(tx, context, date, now, ignore)).map(({ staff, work, blocked }) => ({
    staff,
    starts: openTimes({ work, blocked, now, ...length, travel: context.travel }),
  }));
}

export async function getAvailability(input: z.infer<typeof availabilitySchema>, now = Date.now()) {
  return db.$transaction(
    async (tx) => {
      const context = await prepare(tx, input);
      const length = lengthOf(context.services);
      const times = await staffTimes(tx, context, input.date, length, now);
      const starts = [...new Set(times.flatMap((item) => item.starts))].sort((a, b) => a - b);
      return {
        timeZone: context.branch.timeZone,
        duration: length.duration,
        travelPaise: context.travelPaise,
        totalPaise: checkoutPrice(context).totalPaise,
        slots: starts.map((start) => ({
          startsAt: new Date(start),
          staffCount: times.filter((item) => item.starts.includes(start)).length,
        })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

function conflict() {
  return new HttpError(409, "That time is no longer available. Choose another time.", "SLOT_UNAVAILABLE");
}

function translateConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      JSON.stringify(error.meta ?? {}).includes("23P01") ||
      JSON.stringify(error.meta ?? {}).includes("booking_staff_overlap"))
  ) {
    throw conflict();
  }
  if (error instanceof Error && error.message.includes("booking_staff_overlap")) throw conflict();
  throw error;
}

async function chooseStaff(
  tx: Tx,
  context: ScheduleContext,
  length: Length,
  start: number,
  now: number,
  ignore?: string,
) {
  const times = await staffTimes(tx, context, localDate(start, context.branch.timeZone), length, now, ignore);
  const staff = times.find((entry) => entry.starts.includes(start))?.staff;
  if (!staff) throw conflict();
  return staff.id;
}

function bookingValues(
  context: Prepared,
  visit: Pick<Selection, "mode" | "location">,
  slot: ReturnType<typeof reservation>,
  price = checkoutPrice(context),
  loyaltyDiscountPaise = 0,
) {
  return {
    providerId: context.provider.id,
    branchId: context.branch.id,
    mode: visit.mode,
    timeZone: context.branch.timeZone,
    ...slot,
    ...(visit.mode === "HOME" && visit.location ? visit.location : {}),
    cancelBeforeHours: context.provider.cancelBeforeHours,
    travelPaise: context.travelPaise,
    totalPaise: price.totalPaise,
    discountPaise: price.discountPaise,
    loyaltyDiscountPaise,
    taxPaise: price.taxPaise,
    taxRateBps: price.taxRateBps,
    supplierGstin: context.provider.gstRegistered ? context.provider.gstin : null,
    freeRefundHours: context.provider.freeRefundHours,
    noRefundHours: context.provider.noRefundHours,
    cancellationFeeBps: context.provider.cancellationFeeBps,
    noShowFeeBps: context.provider.noShowFeeBps,
    items: {
      create: context.services.map((service, position) => ({
        serviceId: service.id,
        name: service.name,
        pricePaise: service.pricePaise,
        duration: service.duration,
        buffer: service.buffer,
        commissionBps: resolveCommissionBps(
          context.defaultCommissionBps,
          service.category.commissionBps,
          context.provider.commissionBps,
        ),
        position,
      })),
    },
  };
}

export async function createBooking(customerId: string, input: BookingInput, clock?: number) {
  const { requestKey, ...rest } = input;
  const requestHash = digest(JSON.stringify(rest));
  if (input.mode === "HOME" && !input.location?.address)
    throw new HttpError(400, "Enter the full home-visit address.");
  const existing = async (tx: Tx) => {
    const booked = await tx.booking.findUnique({
      where: { customerId_requestKey: { customerId, requestKey } },
      include: bookingInclude,
    });
    if (booked && booked.requestHash !== requestHash)
      throw new HttpError(
        409,
        "This booking request key was already used for another selection.",
        "REQUEST_KEY_REUSED",
      );
    return booked;
  };
  try {
    return await db.$transaction(async (tx) => {
      await lockProvider(tx, input.providerId);
      const booked = await existing(tx);
      if (booked) return { booking: booked, created: false };
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${customerId} FOR UPDATE`;
      await lockCoupon(tx, input.couponCode);
      const now = clock ?? Date.now();
      await releaseProviderHolds(tx, input.providerId, new Date(now));
      const context = await prepare(tx, input);
      const discounts = await checkoutDiscounts(tx, customerId, input, context, new Date(now));
      const length = lengthOf(context.services);
      const start = Date.parse(input.startsAt);
      const paymentMode = input.paymentMode ?? "PAY_AT_VENUE";
      const wallet = input.useWallet ? await lockWallet(tx, customerId) : 0;
      const price = checkoutPrice(context, paymentMode, wallet, discounts.discountPaise);
      const data = bookingValues(
        context,
        input,
        reservation(start, length.duration, length.buffer, context.travel),
        price,
        discounts.loyaltyDiscountPaise,
      );
      if (
        (input.expectedTotalPaise !== undefined && input.expectedTotalPaise !== price.totalPaise) ||
        (input.expectedWalletPaise !== undefined && input.expectedWalletPaise !== price.walletUsedPaise)
      ) {
        throw new HttpError(
          409,
          "The appointment price changed. Review the updated total and select a time again.",
          "PRICE_CHANGED",
        );
      }
      if (price.gatewayAmountPaise > 0 && price.gatewayAmountPaise < 100)
        throw new HttpError(400, "The minimum online payment is ₹1.00. Select pay at venue.");
      const staffId = await chooseStaff(tx, context, length, start, now);
      const holdExpiresAt = price.gatewayAmountPaise ? new Date(Math.min(now + 10 * MINUTE, start)) : null;
      const booking = await tx.booking.create({
        data: {
          ...data,
          customerId,
          staffId,
          requestKey,
          requestHash,
          status: !holdExpiresAt && context.provider.autoConfirm ? "CONFIRMED" : "PENDING",
          paymentMode,
          holdExpiresAt,
          confirmAfterPayment: context.provider.autoConfirm,
          payment: {
            create: {
              status: price.gatewayAmountPaise || !price.walletUsedPaise ? "CREATED" : "CAPTURED",
              gatewayAmountPaise: price.gatewayAmountPaise,
              walletUsedPaise: price.walletUsedPaise,
              dueAtVenuePaise: price.dueAtVenuePaise,
            },
          },
        },
        include: bookingInclude,
      });
      await walletMovement(
        tx,
        customerId,
        booking.id,
        -price.walletUsedPaise,
        "checkout:" + booking.id,
        customerId,
      );
      if (discounts.coupon && discounts.couponDiscountPaise) {
        await reserveCouponUsage(tx, {
          couponId: discounts.coupon.id,
          userId: customerId,
          bookingId: booking.id,
          code: discounts.coupon.code,
          discountPaise: discounts.couponDiscountPaise,
          funding: discounts.coupon.funding,
        });
      }
      if (discounts.loyaltyPoints) {
        await spendLoyaltyPoints(tx, customerId, booking.id, discounts.loyaltyPoints, new Date(now));
      }
      if (holdExpiresAt)
        await moneyAudit(tx, "PAYMENT_HOLD_CREATED", booking.id, price.gatewayAmountPaise, customerId);
      await tx.auditLog.create({
        data: { actorId: customerId, targetId: booking.id, action: "BOOKING_CREATED" },
      });
      await notifyBooking(tx, booking.id, {
        eventType: booking.status === "CONFIRMED" ? "BOOKING_CONFIRMED" : "BOOKING_CREATED",
        title: booking.status === "CONFIRMED" ? "Appointment confirmed" : "Appointment request received",
        body: `${booking.provider.displayName} appointment details are available in your bookings.`,
      });
      await scheduleBookingReminders(tx, booking.id);
      return { booking, created: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const booked = await existing(db);
      if (booked) return { booking: booked, created: false };
    }
    return translateConflict(error);
  }
}

export async function createWalkIn(user: Viewer, input: WalkInInput, clock?: number) {
  if (user.role !== "PROVIDER") throw new HttpError(403, "Only salon owners can record walk-ins.");
  const { requestKey, customerName, ...selection } = input;
  const requestHash = digest(JSON.stringify({ ...selection, customerName }));
  try {
    return await db.$transaction(async (tx) => {
      await lockProvider(tx, input.providerId);
      const shop = await tx.providerProfile.findFirst({
        where: { id: input.providerId, ownerId: user.id, type: "SHOP" },
        select: { status: true },
      });
      if (!shop) throw new HttpError(404, "Salon not found.");
      const booked = await tx.booking.findUnique({
        where: { providerId_walkInKey: { providerId: input.providerId, walkInKey: requestKey } },
        include: bookingInclude,
      });
      if (booked) {
        if (booked.requestHash !== requestHash)
          throw new HttpError(
            409,
            "This booking request key was already used for another selection.",
            "REQUEST_KEY_REUSED",
          );
        return { booking: booked, created: false };
      }
      if (shop.status !== "APPROVED")
        throw new HttpError(409, "Salon approval is required to record walk-ins.");
      const visit = { ...selection, mode: "VENUE" as const };
      const context = await prepare(tx, visit);
      const start = clock ?? Date.now();
      await releaseProviderHolds(tx, input.providerId, new Date(start));
      const price = checkoutPrice(context);
      const length = lengthOf(context.services);
      const slot = reservation(start, length.duration, length.buffer, 0);
      const schedules = await staffSchedules(tx, context, localDate(start, context.branch.timeZone), start);
      const staff = schedules.find(({ work, blocked }) =>
        canReserve({ start: +slot.reservedFrom, end: +slot.reservedUntil }, work, blocked),
      )?.staff;
      if (!staff) throw conflict();
      const guest = await tx.user.create({
        data: { name: customerName, role: "CUSTOMER", customer: { create: {} } },
        select: { id: true },
      });
      const booking = await tx.booking.create({
        data: {
          ...bookingValues(context, visit, slot, price),
          customerId: guest.id,
          staffId: staff.id,
          requestKey,
          requestHash,
          walkInKey: requestKey,
          status: "IN_PROGRESS",
          payment: {
            create: { gatewayAmountPaise: 0, walletUsedPaise: 0, dueAtVenuePaise: price.dueAtVenuePaise },
          },
        },
        include: bookingInclude,
      });
      await tx.auditLog.create({
        data: { actorId: user.id, targetId: booking.id, action: "WALK_IN_CREATED" },
      });
      return { booking, created: true };
    });
  } catch (error) {
    return translateConflict(error);
  }
}

const transitions: Partial<Record<BookingStatus, BookingStatus[]>> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "CANCELLED", "NO_SHOW"],
  IN_PROGRESS: ["COMPLETED"],
};

function canEdit(
  booking: { status: BookingStatus; startsAt: Date; cancelBeforeHours: number; holdExpiresAt: Date | null },
  now: number,
  customer: boolean,
) {
  if (booking.holdExpiresAt) throw new HttpError(409, "Finish payment before changing the appointment.");
  if (!["PENDING", "CONFIRMED"].includes(booking.status))
    throw new HttpError(409, "This appointment can no longer be changed.");
  if (customer && +booking.startsAt - now < Math.max(booking.cancelBeforeHours * 60 * MINUTE, 1)) {
    throw new HttpError(409, "This appointment is past its change or cancellation deadline.");
  }
}

function authorized(
  user: Viewer,
  booking: {
    customerId: string;
    provider: { ownerId: string };
    staff: { userId: string | null; active: boolean };
  },
) {
  return (
    (user.role === "CUSTOMER" && user.id === booking.customerId) ||
    (user.role === "PROVIDER" && user.id === booking.provider.ownerId) ||
    (user.role === "STAFF" && booking.staff.active && user.id === booking.staff.userId) ||
    user.role === "ADMIN"
  );
}

async function modify<T>(
  id: string,
  user: Viewer,
  callback: (tx: Tx, booking: Prisma.BookingGetPayload<{ include: typeof editInclude }>) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(async (tx) => {
      const first = await tx.booking.findUnique({ where: { id }, select: { providerId: true } });
      if (!first) throw new HttpError(404, "Appointment not found.");
      await lockProvider(tx, first.providerId);
      const booking = await tx.booking.findUnique({ where: { id }, include: editInclude });
      if (!booking || !authorized(user, booking)) throw new HttpError(404, "Appointment not found.");
      return callback(tx, booking);
    });
  } catch (error) {
    return translateConflict(error);
  }
}

const editInclude = {
  ...bookingInclude,
  provider: { select: { ownerId: true, displayName: true } },
  staff: { select: { userId: true, active: true } },
} as const satisfies Prisma.BookingInclude;

type EditableBooking = Prisma.BookingGetPayload<{ include: typeof editInclude }>;

async function cancellationDetails(
  tx: Tx,
  booking: EditableBooking,
  user: Viewer,
  now: number,
  noShow = false,
) {
  const funding = await refundCapacity(tx, booking.id);
  const reason = noShow
    ? "NO_SHOW"
    : booking.holdExpiresAt
      ? "HOLD_RELEASE"
      : user.role === "CUSTOMER"
        ? "CUSTOMER_CANCEL"
        : "PROVIDER_CANCEL";
  const quote = cancellationQuote({
    policy: booking,
    totalPaise: booking.totalPaise,
    availablePaise: funding.availablePaise,
    minutesBefore: (+booking.startsAt - now) / MINUTE,
    reason,
  });
  return { funding, quote, reason };
}

function assertCancelable(booking: EditableBooking, user: Viewer, now: number) {
  if (
    !["CONFIRMED", "PENDING"].includes(booking.status) ||
    (user.role === "CUSTOMER" && !booking.holdExpiresAt && +booking.startsAt <= now)
  )
    throw new HttpError(409, "This appointment can no longer be cancelled.");
}

export async function previewCancellation(id: string, user: Viewer, now = Date.now()) {
  return modify(id, user, async (tx, booking) => {
    assertCancelable(booking, user, now);
    const { funding, quote } = await cancellationDetails(tx, booking, user, now);
    return { ...quote, originalAvailable: funding.gatewayPaise > 0, currency: booking.currency };
  });
}

async function settleCancellation(
  tx: Tx,
  booking: EditableBooking,
  user: Viewer,
  input: { requestKey: string; destination: "WALLET" | "ORIGINAL"; expectedRefundPaise?: number },
  now: number,
  status: "CANCELLED" | "NO_SHOW",
) {
  const { funding, quote, reason } = await cancellationDetails(tx, booking, user, now, status === "NO_SHOW");
  if (input.expectedRefundPaise !== undefined && input.expectedRefundPaise !== quote.refundPaise)
    throw new HttpError(409, "The refund changed. Review the current preview.", "REFUND_CHANGED");
  if (booking.holdExpiresAt) {
    await cancelPaymentHold(tx, booking.id, new Date(now), user.id);
  } else {
    if (quote.refundPaise)
      await requestRefund(
        tx,
        booking,
        funding,
        {
          amountPaise: quote.refundPaise,
          requestKey: input.requestKey,
          destination: input.destination,
          actorId: user.id,
          reason,
        },
        new Date(now),
      );
    await tx.booking.update({
      where: { id: booking.id },
      data: { status, retainedFeePaise: quote.retainedPaise },
    });
    if (status === "NO_SHOW") await completeCouponUsage(tx, booking.id);
    else {
      await releaseCouponUsage(tx, booking.id);
      await restoreLoyaltyPoints(tx, booking.customerId, booking.id);
    }
  }
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      targetId: booking.id,
      action: "BOOKING_STATUS_CHANGED",
      metadata: { from: booking.status, to: status, reason, ...quote },
    },
  });
  await notifyBooking(tx, booking.id, {
    eventType: status === "NO_SHOW" ? "BOOKING_NO_SHOW" : "BOOKING_CANCELLED",
    title: status === "NO_SHOW" ? "Appointment marked no-show" : "Appointment cancelled",
    body: `The appointment with ${booking.provider.displayName} was ${status === "NO_SHOW" ? "marked no-show" : "cancelled"}.`,
  });
  await scheduleBookingReminders(tx, booking.id);
  return quote;
}

export async function cancelAppointment(
  id: string,
  user: Viewer,
  input: z.infer<typeof cancelAppointmentSchema>,
  now = Date.now(),
) {
  return modify(id, user, async (tx, booking) => {
    const { requestKey, ...details } = input;
    const requestHash = digest(JSON.stringify(details));
    const prior = await tx.bookingChange.findUnique({
      where: { bookingId_requestKey: { bookingId: id, requestKey } },
    });
    if (prior && (prior.kind !== "CANCELLED" || prior.requestHash !== requestHash))
      throw new HttpError(409, "This booking change key was already used.");
    if (!prior && booking.status !== "CANCELLED") {
      assertCancelable(booking, user, now);
      const quote = await settleCancellation(tx, booking, user, input, now, "CANCELLED");
      await tx.bookingChange.create({
        data: {
          bookingId: id,
          requestKey,
          requestHash,
          kind: "CANCELLED",
          oldTotalPaise: booking.totalPaise,
          newTotalPaise: quote.retainedPaise,
          refundPaise: quote.refundPaise,
        },
      });
    }
    return tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
  });
}

async function reschedulePrice(tx: Tx, booking: EditableBooking) {
  const services = await tx.service.findMany({
    where: { id: { in: booking.items.map((item) => item.serviceId) }, active: true },
    select: { id: true, pricePaise: true },
  });
  const prices = new Map(services.map(({ id, pricePaise }) => [id, pricePaise]));
  const items = booking.items.map((item) => ({
    ...item,
    pricePaise: prices.get(item.serviceId) ?? item.pricePaise,
  }));
  const subtotal = items.reduce((sum, item) => sum + item.pricePaise, booking.travelPaise);
  const taxPaise = portion(subtotal, booking.taxRateBps);
  const totalPaise = subtotal + taxPaise;
  const funding = await refundCapacity(tx, booking.id);
  const refundPaise = Math.max(0, funding.availablePaise - totalPaise);
  const dueAtVenuePaise = Math.max(0, totalPaise - funding.availablePaise);
  return {
    funding,
    items,
    taxPaise,
    totalPaise,
    refundPaise,
    dueAtVenuePaise,
    differencePaise: totalPaise - booking.totalPaise,
  };
}

async function prepareReschedule(
  tx: Tx,
  booking: Prisma.BookingGetPayload<{ include: typeof editInclude }>,
  nextStaffId = booking.staffId,
) {
  const { provider, branch } = await bookableLocation(tx, booking.providerId, booking.branchId);
  if (booking.mode === "HOME" && nextStaffId !== booking.staffId && !provider.homeEnabled) throw conflict();
  const staff = await eligibleStaff(
    tx,
    {
      providerId: booking.providerId,
      branchId: branch.id,
      staffId: nextStaffId,
      mode: booking.mode,
      serviceIds: booking.items.map((item) => item.serviceId),
    },
    booking.staffId,
  );
  const travel = (+booking.startsAt - +booking.reservedFrom) / MINUTE;
  return { branch, staff, travel };
}

export async function rescheduleBooking(id: string, user: Viewer, input: RescheduleInput, now = Date.now()) {
  return modify(id, user, async (tx, booking) => {
    const { requestKey, ...details } = input;
    const requestHash = digest(JSON.stringify(details));
    if (requestKey) {
      const prior = await tx.bookingChange.findUnique({
        where: { bookingId_requestKey: { bookingId: id, requestKey } },
      });
      if (prior) {
        if (prior.kind !== "RESCHEDULED" || prior.requestHash !== requestHash)
          throw new HttpError(409, "This booking change key was already used.");
        return tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
      }
    } else if (
      Date.parse(input.startsAt) === +booking.startsAt &&
      (!input.staffId || input.staffId === booking.staffId)
    ) {
      return tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    }
    canEdit(booking, now, user.role === "CUSTOMER");
    if (user.role === "STAFF" && input.staffId && input.staffId !== booking.staffId)
      throw new HttpError(403, "You can only reschedule your own appointments.");
    const context = await prepareReschedule(tx, booking, input.staffId);
    const length = lengthOf(booking.items);
    const start = Date.parse(input.startsAt);
    await releaseProviderHolds(tx, booking.providerId, new Date(now));
    const staffId = await chooseStaff(tx, context, length, start, now, id);
    const price = requestKey ? await reschedulePrice(tx, booking) : undefined;
    if (requestKey && price) {
      if (input.expectedTotalPaise !== price.totalPaise)
        throw new HttpError(409, "The reschedule price changed. Check the current price.", "PRICE_CHANGED");
      if (price.refundPaise)
        await requestRefund(
          tx,
          booking,
          price.funding,
          {
            amountPaise: price.refundPaise,
            requestKey,
            destination: "WALLET",
            reason: "Reschedule price adjustment",
            actorId: user.id,
          },
          new Date(now),
        );
      await tx.payment.upsert({
        where: { bookingId: id },
        create: {
          bookingId: id,
          walletUsedPaise: 0,
          gatewayAmountPaise: 0,
          dueAtVenuePaise: price.dueAtVenuePaise,
        },
        update: { dueAtVenuePaise: price.dueAtVenuePaise },
      });
      for (const item of price.items) {
        await tx.bookingItem.update({ where: { id: item.id }, data: { pricePaise: item.pricePaise } });
      }
      await tx.bookingChange.create({
        data: {
          bookingId: id,
          requestKey,
          requestHash,
          kind: "RESCHEDULED",
          oldTotalPaise: booking.totalPaise,
          newTotalPaise: price.totalPaise,
          refundPaise: price.refundPaise,
        },
      });
    }
    const updated = await tx.booking.update({
      where: { id },
      data: {
        staffId,
        ...reservation(start, length.duration, length.buffer, context.travel),
        ...(price ? { totalPaise: price.totalPaise, taxPaise: price.taxPaise } : {}),
      },
      include: bookingInclude,
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        targetId: id,
        action: "BOOKING_RESCHEDULED",
        metadata: { previous: booking.startsAt.toISOString(), next: updated.startsAt.toISOString() },
      },
    });
    await notifyBooking(tx, id, {
      eventType: "BOOKING_RESCHEDULED",
      title: "Appointment rescheduled",
      body: "The appointment time was updated. Review the latest details in your bookings.",
    });
    await scheduleBookingReminders(tx, id);
    return updated;
  });
}

export async function rescheduleTimes(id: string, user: Viewer, date: string, now = Date.now()) {
  return modify(id, user, async (tx, booking) => {
    canEdit(booking, now, user.role === "CUSTOMER");
    const context = await prepareReschedule(tx, booking);
    const times = await staffTimes(tx, context, date, lengthOf(booking.items), now, id);
    const price = await reschedulePrice(tx, booking);
    return {
      timeZone: booking.timeZone,
      slots: (times[0]?.starts ?? []).map((start) => new Date(start)),
      price: {
        differencePaise: price.differencePaise,
        totalPaise: price.totalPaise,
        refundPaise: price.refundPaise,
        dueAtVenuePaise: price.dueAtVenuePaise,
      },
    };
  });
}

export async function changeBooking(id: string, user: Viewer, status: BookingStatus, now = Date.now()) {
  return modify(id, user, async (tx, booking) => {
    if (booking.status === status)
      return tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    if (booking.holdExpiresAt) {
      if (status !== "CANCELLED") throw new HttpError(409, "Payment is still pending.");
    } else {
      if (user.role === "CUSTOMER") {
        if (status !== "CANCELLED")
          throw new HttpError(403, "Customers can only cancel their own appointments.");
        canEdit(booking, now, true);
      } else {
        if (!transitions[booking.status]?.includes(status))
          throw new HttpError(409, "This status change is unavailable.");
        if (["NO_SHOW", "IN_PROGRESS"].includes(status) && +booking.startsAt > now)
          throw new HttpError(409, "The appointment has not started yet.");
        if (status === "CONFIRMED" && +booking.startsAt <= now)
          throw new HttpError(409, "The appointment time has passed.");
      }
    }
    if (status === "CANCELLED" || status === "NO_SHOW") {
      await settleCancellation(
        tx,
        booking,
        user,
        { requestKey: "status:" + status, destination: "ORIGINAL" },
        now,
        status,
      );
      if (status === "NO_SHOW") await recordBookingCompletion(tx, id, user.id);
      return tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    }
    const updated = await tx.booking.update({ where: { id }, data: { status }, include: bookingInclude });
    if (status === "COMPLETED") {
      await recordBookingCompletion(tx, id, user.id);
      await completePhaseTwoRewards(tx, id, user.id, new Date(now));
      await issueBookingInvoices(tx, id, new Date(now));
      await notifyBooking(tx, id, {
        eventType: "BOOKING_COMPLETED",
        title: "Appointment completed",
        body: "Your appointment is complete. Your invoice and review form are available.",
      });
      const current = await tx.booking.findUniqueOrThrow({ where: { id }, select: { customerId: true } });
      await enqueueEvent(tx, {
        userId: current.customerId,
        bookingId: id,
        eventType: "REVIEW_PROMPT",
        title: "Share your experience",
        body: "Leave a review for your completed appointment.",
        idempotencyKey: `review-prompt:${id}:${current.customerId}`,
      });
    }
    if (status === "CONFIRMED") {
      await notifyBooking(tx, id, {
        eventType: "BOOKING_CONFIRMED",
        title: "Appointment confirmed",
        body: "Your appointment is confirmed. Check your booking for the latest details.",
      });
      await scheduleBookingReminders(tx, id);
    }
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        targetId: id,
        action: "BOOKING_STATUS_CHANGED",
        metadata: { from: booking.status, to: status },
      },
    });
    return updated;
  });
}

export async function listBookings(user: Viewer, calendar?: { branchId: string; from: Date; until: Date }) {
  const where: Prisma.BookingWhereInput =
    user.role === "CUSTOMER"
      ? { customerId: user.id }
      : user.role === "PROVIDER"
        ? { provider: { ownerId: user.id } }
        : user.role === "STAFF"
          ? { staff: { userId: user.id, active: true } }
          : {};
  const include = { ...bookingInclude, customer: { select: { user: { select: { name: true } } } } } as const;
  if (calendar)
    return db.booking.findMany({
      where: { ...where, branchId: calendar.branchId, startsAt: { gte: calendar.from, lt: calendar.until } },
      include,
      orderBy: { startsAt: "asc" },
    });
  const now = new Date();
  const [recent, upcoming] = await Promise.all([
    db.booking.findMany({
      where: { ...where, startsAt: { lt: now } },
      include,
      orderBy: { startsAt: "desc" },
      take: 100,
    }),
    db.booking.findMany({
      where: { ...where, startsAt: { gte: now } },
      include,
      orderBy: { startsAt: "asc" },
      take: 150,
    }),
  ]);
  return [...recent.reverse(), ...upcoming];
}
