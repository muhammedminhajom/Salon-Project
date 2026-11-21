import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import type { z } from "zod";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { portion } from "@/lib/money";
import { enqueueEvent } from "@/lib/notifications";
import { couponSchema } from "@/lib/schemas";

type Tx = PrismaTypes.TransactionClient;
type CouponInput = z.infer<typeof couponSchema>;

export type CouponQuoteInput = {
  customerId: string;
  code?: string;
  providerId: string;
  categoryIds: string[];
  serviceSubtotalPaise: number;
  cartSubtotalPaise: number;
  now: Date;
};

export async function lockCoupon(tx: Tx, code?: string) {
  if (!code) return;
  await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Coupon" WHERE "code" = ${code} FOR UPDATE`;
}

export async function quoteCoupon(tx: Tx, input: CouponQuoteInput) {
  if (!input.code) return { coupon: null, discountPaise: 0 };
  const coupon = await tx.coupon.findUnique({ where: { code: input.code } });
  const invalid = () =>
    new HttpError(400, "This coupon is unavailable or does not apply to this booking.", "COUPON_INVALID");
  if (
    !coupon ||
    !coupon.active ||
    coupon.validFrom > input.now ||
    coupon.validUntil <= input.now ||
    (coupon.totalUses !== null && coupon.usageCount >= coupon.totalUses) ||
    input.cartSubtotalPaise < coupon.minCartPaise ||
    (coupon.providerId && coupon.providerId !== input.providerId) ||
    (coupon.categoryId && !input.categoryIds.includes(coupon.categoryId))
  )
    throw invalid();
  if (coupon.kind === "CATEGORY" && (!coupon.categoryId || !input.categoryIds.includes(coupon.categoryId)))
    throw invalid();
  if (coupon.kind === "PROVIDER" && coupon.providerId !== input.providerId) throw invalid();
  if (coupon.kind === "FIRST_BOOKING") {
    const prior = await tx.booking.count({
      where: { customerId: input.customerId, status: { not: "CANCELLED" } },
    });
    if (prior) throw invalid();
  }
  const userUses = await tx.couponUsage.count({
    where: { couponId: coupon.id, userId: input.customerId, status: { not: "RELEASED" } },
  });
  if (userUses >= coupon.perUserLimit) throw invalid();
  const rawDiscount =
    coupon.discountType === "PERCENT" ? portion(input.serviceSubtotalPaise, coupon.amount) : coupon.amount;
  const discountPaise = Math.min(
    input.serviceSubtotalPaise,
    rawDiscount,
    coupon.maxDiscountPaise ?? Number.MAX_SAFE_INTEGER,
  );
  if (!discountPaise) throw invalid();
  return { coupon, discountPaise };
}

export async function reserveCouponUsage(
  tx: Tx,
  input: {
    couponId: string;
    userId: string;
    bookingId: string;
    code: string;
    discountPaise: number;
    funding: "PLATFORM" | "PROVIDER";
  },
) {
  await tx.coupon.update({ where: { id: input.couponId }, data: { usageCount: { increment: 1 } } });
  await tx.couponUsage.create({
    data: {
      couponId: input.couponId,
      userId: input.userId,
      bookingId: input.bookingId,
      codeSnapshot: input.code,
      discountPaise: input.discountPaise,
      funding: input.funding,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.userId,
      targetId: input.bookingId,
      action: "COUPON_REDEEMED",
      metadata: { code: input.code, discountPaise: input.discountPaise, funding: input.funding },
    },
  });
}

export async function releaseCouponUsage(tx: Tx, bookingId: string) {
  const usage = await tx.couponUsage.findUnique({ where: { bookingId } });
  if (!usage || usage.status !== "RESERVED") return false;
  await tx.couponUsage.update({ where: { id: usage.id }, data: { status: "RELEASED" } });
  await tx.coupon.update({ where: { id: usage.couponId }, data: { usageCount: { decrement: 1 } } });
  return true;
}

export async function completeCouponUsage(tx: Tx, bookingId: string) {
  await tx.couponUsage.updateMany({
    where: { bookingId, status: "RESERVED" },
    data: { status: "COMPLETED" },
  });
}

export async function listCoupons(providerId?: string) {
  return db.coupon.findMany({
    where: providerId ? { providerId } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      code: true,
      kind: true,
      discountType: true,
      funding: true,
      amount: true,
      maxDiscountPaise: true,
      minCartPaise: true,
      totalUses: true,
      usageCount: true,
      perUserLimit: true,
      validFrom: true,
      validUntil: true,
      active: true,
      categoryId: true,
    },
  });
}

export async function createCoupon(actorId: string, input: CouponInput, providerId?: string) {
  if (providerId && input.funding !== "PROVIDER")
    throw new HttpError(400, "Provider coupons must be provider-funded.");
  if (!providerId && input.funding !== "PLATFORM")
    throw new HttpError(400, "Admin-created coupons must be platform-funded.");
  if (!providerId && input.kind !== "PROVIDER" && input.providerId)
    throw new HttpError(400, "Only a provider-specific coupon can target a provider.");
  const categoryId = input.kind === "CATEGORY" ? input.categoryId : null;
  const targetProviderId = providerId ?? (input.kind === "PROVIDER" ? input.providerId : null);
  if (providerId) {
    const profile = await db.providerProfile.findFirst({
      where: { id: providerId, ownerId: actorId, status: "APPROVED" },
      select: { id: true },
    });
    if (!profile) throw new HttpError(403, "Approved providers can manage their own coupons.");
  }
  try {
    const coupon = await db.$transaction(async (tx) => {
      if (
        categoryId &&
        !(await tx.serviceCategory.findUnique({ where: { id: categoryId }, select: { id: true } }))
      )
        throw new HttpError(404, "Coupon category not found.");
      if (
        targetProviderId &&
        !(await tx.providerProfile.findUnique({ where: { id: targetProviderId }, select: { id: true } }))
      )
        throw new HttpError(404, "Coupon provider not found.");
      const result = await tx.coupon.create({
        data: {
          code: input.code,
          kind: input.kind,
          discountType: input.discountType,
          funding: providerId ? "PROVIDER" : "PLATFORM",
          providerId: targetProviderId,
          categoryId,
          createdById: actorId,
          amount: input.amount,
          maxDiscountPaise: input.maxDiscountPaise,
          minCartPaise: input.minCartPaise,
          totalUses: input.totalUses,
          perUserLimit: input.perUserLimit,
          validFrom: new Date(input.validFrom),
          validUntil: new Date(input.validUntil),
          active: input.active,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId: result.id,
          action: "COUPON_CREATED",
          metadata: { code: result.code, funding: result.funding, providerId: result.providerId },
        },
      });
      if (result.active) {
        const recipients = providerId
          ? await tx.booking
              .findMany({
                where: { providerId },
                distinct: ["customerId"],
                orderBy: { customerId: "asc" },
                take: 5000,
                select: { customerId: true },
              })
              .then((rows) => rows.map(({ customerId }) => customerId))
          : await tx.user
              .findMany({
                where: { role: "CUSTOMER" },
                orderBy: { id: "asc" },
                take: 5000,
                select: { id: true },
              })
              .then((rows) => rows.map(({ id }) => id));
        const scheduledAt = result.validFrom > new Date() ? result.validFrom : new Date();
        for (const userId of recipients) {
          await enqueueEvent(tx, {
            userId,
            eventType: "COUPON_OFFER",
            title: "A new beauty offer is available",
            body: `Use coupon code ${result.code} for a booking offer.`,
            idempotencyKey: `coupon-offer:${result.id}:${userId}`,
            scheduledAt,
          });
        }
      }
      return result;
    });
    return coupon;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new HttpError(409, "That coupon code is already in use.");
    throw error;
  }
}

export async function updateCoupon(actorId: string, id: string, active: boolean, providerId?: string) {
  return db.$transaction(async (tx) => {
    const coupon = await tx.coupon.findFirst({ where: { id, ...(providerId ? { providerId } : {}) } });
    if (!coupon) throw new HttpError(404, "Coupon not found.");
    if (!providerId && coupon.providerId)
      throw new HttpError(403, "Provider coupons are managed by their owner.");
    const updated = await tx.coupon.update({ where: { id }, data: { active } });
    await tx.auditLog.create({
      data: { actorId, targetId: id, action: active ? "COUPON_ACTIVATED" : "COUPON_DEACTIVATED" },
    });
    return updated;
  });
}

export { couponSchema };
