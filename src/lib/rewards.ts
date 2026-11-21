import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { postLedgerBatch } from "@/lib/finance-ledger";
import { walletMovement } from "@/lib/payment-records";
import { HttpError } from "@/lib/http";

type Tx = Prisma.TransactionClient;

function bucketKey(expiresAt: Date | null) {
  return expiresAt?.toISOString() ?? "never";
}

function aggregateBuckets(entries: { points: number; expiresAt: Date | null }[], now: Date) {
  const buckets = new Map<string, { expiresAt: Date | null; points: number }>();
  for (const entry of entries) {
    if (entry.expiresAt && entry.expiresAt <= now) continue;
    const key = bucketKey(entry.expiresAt);
    const bucket = buckets.get(key) ?? { expiresAt: entry.expiresAt, points: 0 };
    bucket.points += entry.points;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.points > 0)
    .sort((left, right) => {
      if (!left.expiresAt) return right.expiresAt ? 1 : 0;
      if (!right.expiresAt) return -1;
      return left.expiresAt.getTime() - right.expiresAt.getTime();
    });
}

export async function getLoyaltyPoints(tx: Tx, userId: string, now = new Date()) {
  const entries = await tx.loyaltyEntry.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { points: true, expiresAt: true },
  });
  return aggregateBuckets(entries, now).reduce((sum, bucket) => sum + bucket.points, 0);
}

export async function spendLoyaltyPoints(
  tx: Tx,
  userId: string,
  bookingId: string,
  points: number,
  now = new Date(),
) {
  if (!points) return;
  const entries = await tx.loyaltyEntry.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { points: true, expiresAt: true },
  });
  const buckets = aggregateBuckets(entries, now);
  if (buckets.reduce((sum, bucket) => sum + bucket.points, 0) < points)
    throw new HttpError(409, "Your loyalty points changed. Review the updated checkout.", "PRICE_CHANGED");
  let remaining = points;
  for (const bucket of buckets) {
    if (!remaining) break;
    const use = Math.min(bucket.points, remaining);
    const suffix = createHash("sha256").update(bucketKey(bucket.expiresAt)).digest("hex").slice(0, 12);
    await tx.loyaltyEntry.create({
      data: {
        userId,
        reference: `booking:${bookingId}:loyalty:${suffix}`,
        points: -use,
        expiresAt: bucket.expiresAt,
      },
    });
    remaining -= use;
  }
  await tx.auditLog.create({
    data: { actorId: userId, targetId: bookingId, action: "LOYALTY_POINTS_REDEEMED", metadata: { points } },
  });
}

export async function restoreLoyaltyPoints(tx: Tx, userId: string, bookingId: string) {
  const spent = await tx.loyaltyEntry.findMany({
    where: { userId, reference: { startsWith: `booking:${bookingId}:loyalty:` } },
    select: { id: true, points: true, expiresAt: true },
  });
  for (const [index, entry] of spent.entries()) {
    const reference = `booking:${bookingId}:loyalty-restore:${index}`;
    if (await tx.loyaltyEntry.findUnique({ where: { reference }, select: { id: true } })) continue;
    await tx.loyaltyEntry.create({
      data: { userId, reference, points: -entry.points, expiresAt: entry.expiresAt },
    });
  }
  if (spent.length)
    await tx.auditLog.create({
      data: { targetId: bookingId, action: "LOYALTY_POINTS_RESTORED", metadata: { entries: spent.length } },
    });
}

export async function completePhaseTwoRewards(tx: Tx, bookingId: string, actorId: string, now = new Date()) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, customerId: true, totalPaise: true, referralRewarded: true },
  });
  if (!booking || booking.status !== "COMPLETED") return;
  await tx.couponUsage.updateMany({
    where: { bookingId, status: "RESERVED" },
    data: { status: "COMPLETED" },
  });
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${booking.customerId} FOR UPDATE`;
  const settings = await tx.financeSetting.findUniqueOrThrow({ where: { id: "platform" } });
  if (settings.loyaltyPointsPerVisit > 0) {
    const reference = `booking-completed:${bookingId}`;
    if (!(await tx.loyaltyEntry.findUnique({ where: { reference }, select: { id: true } }))) {
      await tx.loyaltyEntry.create({
        data: {
          userId: booking.customerId,
          reference,
          points: settings.loyaltyPointsPerVisit,
          expiresAt: new Date(now.getTime() + settings.loyaltyExpiryDays * 86_400_000),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId: bookingId,
          action: "LOYALTY_POINTS_EARNED",
          metadata: { points: settings.loyaltyPointsPerVisit },
        },
      });
    }
  }
  if (booking.referralRewarded) return;
  const completedBefore = await tx.booking.count({
    where: { customerId: booking.customerId, status: "COMPLETED", id: { not: bookingId } },
  });
  if (completedBefore) return;
  const customer = await tx.user.findUnique({
    where: { id: booking.customerId },
    select: { referredByCodeId: true },
  });
  if (!customer?.referredByCodeId) return;
  const referral = await tx.referralCode.findUniqueOrThrow({
    where: { id: customer.referredByCodeId },
    select: { id: true, userId: true },
  });
  if (referral.userId === booking.customerId) return;
  const rewardPaise = settings.referralRewardPaise;
  await tx.referralReward.create({
    data: {
      referralCodeId: referral.id,
      referrerUserId: referral.userId,
      referredUserId: booking.customerId,
      bookingId,
      referrerPaise: rewardPaise,
      referredPaise: rewardPaise,
    },
  });
  await walletMovement(
    tx,
    referral.userId,
    bookingId,
    rewardPaise,
    `referral:${bookingId}:referrer`,
    actorId,
  );
  await walletMovement(
    tx,
    booking.customerId,
    bookingId,
    rewardPaise,
    `referral:${bookingId}:referred`,
    actorId,
  );
  const totalReward = rewardPaise * 2;
  await postLedgerBatch(tx, {
    reference: `referral-cost:${bookingId}`,
    source: "REFERRAL_REWARD",
    bookingId,
    actorId,
    lines: [
      { account: "PLATFORM_REVENUE", amountPaise: totalReward },
      { account: "CUSTOMER_FUNDS", amountPaise: -totalReward },
    ],
  });
  await tx.booking.update({ where: { id: bookingId }, data: { referralRewarded: true } });
  await tx.auditLog.create({
    data: {
      actorId,
      targetId: bookingId,
      action: "REFERRAL_REWARD_ISSUED",
      metadata: { amountPaise: rewardPaise },
    },
  });
}
