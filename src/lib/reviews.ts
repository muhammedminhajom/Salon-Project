import type { Prisma, ReviewStatus } from "@prisma/client";
import type { Viewer } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { enqueueEvent } from "@/lib/notifications";
import type {
  reviewModerationSchema,
  reviewReplySchema,
  reviewReportSchema,
  reviewSchema,
} from "@/lib/schemas";
import type { z } from "zod";

type Tx = Prisma.TransactionClient;
type ReviewInput = z.infer<typeof reviewSchema>;

export type ReviewPhotoInput = { contentType: string; content: Buffer };

async function refreshRatings(tx: Tx, providerId: string, staffId: string) {
  const [provider, staff] = await Promise.all([
    tx.review.aggregate({
      where: { providerId, status: "PUBLISHED" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    tx.review.aggregate({
      where: { staffId, status: "PUBLISHED" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  await Promise.all([
    tx.providerProfile.update({
      where: { id: providerId },
      data: { rating: provider._avg.rating, reviewCount: provider._count._all },
    }),
    tx.staff.update({
      where: { id: staffId },
      data: { rating: staff._avg.rating, reviewCount: staff._count._all },
    }),
  ]);
}

export async function submitReview(
  user: Viewer,
  input: ReviewInput,
  photos: ReviewPhotoInput[],
  now = new Date(),
) {
  if (user.role !== "CUSTOMER") throw new HttpError(403, "Only customers can review completed bookings.");
  const booking = await db.booking.findFirst({
    where: { id: input.bookingId, customerId: user.id, status: "COMPLETED" },
    select: { id: true, providerId: true, staffId: true },
  });
  if (!booking) throw new HttpError(404, "Only your completed bookings can be reviewed.");
  return db.$transaction(async (tx) => {
    const existing = await tx.review.findUnique({ where: { bookingId: input.bookingId } });
    let review;
    if (existing) {
      if (existing.customerId !== user.id) throw new HttpError(404, "Review not found.");
      if (existing.editUntil <= now) throw new HttpError(409, "The review edit window has closed.");
      review = await tx.review.update({
        where: { id: existing.id },
        data: { rating: input.rating, body: input.body },
      });
      await tx.reviewPhoto.deleteMany({ where: { reviewId: review.id } });
    } else {
      review = await tx.review.create({
        data: {
          bookingId: booking.id,
          customerId: user.id,
          providerId: booking.providerId,
          staffId: booking.staffId,
          rating: input.rating,
          body: input.body,
          editUntil: new Date(now.getTime() + 7 * 86_400_000),
        },
      });
    }
    if (photos.length) {
      await tx.reviewPhoto.createMany({
        data: photos.map((photo) => ({
          reviewId: review.id,
          contentType: photo.contentType,
          content: new Uint8Array(photo.content),
        })),
      });
    }
    await refreshRatings(tx, booking.providerId, booking.staffId);
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        targetId: review.id,
        action: existing ? "REVIEW_EDITED" : "REVIEW_CREATED",
        metadata: { rating: input.rating, photoCount: photos.length },
      },
    });
    if (!existing) {
      const target = await tx.providerProfile.findUniqueOrThrow({
        where: { id: booking.providerId },
        select: { ownerId: true, displayName: true },
      });
      await enqueueEvent(tx, {
        userId: target.ownerId,
        eventType: "REVIEW_RECEIVED",
        title: "New customer review",
        body: `${user.name} left a review for ${target.displayName}.`,
        idempotencyKey: `review-received:${review.id}:${target.ownerId}`,
      });
    }
    return tx.review.findUniqueOrThrow({
      where: { id: review.id },
      include: { photos: { select: { id: true, contentType: true } } },
    });
  });
}

export async function replyToReview(user: Viewer, id: string, input: z.infer<typeof reviewReplySchema>) {
  if (user.role !== "PROVIDER") throw new HttpError(403, "Only providers can reply to reviews.");
  return db.$transaction(async (tx) => {
    const review = await tx.review.findFirst({
      where: { id, provider: { ownerId: user.id }, status: "PUBLISHED" },
      select: { id: true, providerReply: true },
    });
    if (!review) throw new HttpError(404, "Review not found.");
    if (review.providerReply) throw new HttpError(409, "A provider reply can only be added once.");
    const updated = await tx.review.updateMany({
      where: { id, providerReply: null },
      data: { providerReply: input.reply, repliedAt: new Date() },
    });
    if (!updated.count) throw new HttpError(409, "A reply was already added.");
    await tx.auditLog.create({ data: { actorId: user.id, targetId: id, action: "PROVIDER_REVIEW_REPLY" } });
    return tx.review.findUniqueOrThrow({
      where: { id },
      select: { id: true, providerReply: true, repliedAt: true },
    });
  });
}

export async function reportReview(user: Viewer, id: string, input: z.infer<typeof reviewReportSchema>) {
  if (user.role !== "CUSTOMER") throw new HttpError(403, "Only customers can report a review.");
  const review = await db.review.findFirst({
    where: { id, status: "PUBLISHED", customerId: { not: user.id } },
    select: { id: true },
  });
  if (!review) throw new HttpError(404, "Review not found.");
  return db.$transaction(async (tx) => {
    const report = await tx.reviewReport.create({
      data: { reviewId: id, reporterId: user.id, reason: input.reason },
    });
    await tx.auditLog.create({
      data: { actorId: user.id, targetId: id, action: "REVIEW_REPORTED", metadata: { reportId: report.id } },
    });
    return report;
  });
}

export async function listPublicReviews(slug: string, page: number, pageSize = 10) {
  const provider = await db.providerProfile.findFirst({
    where: { slug, status: "APPROVED" },
    select: { id: true },
  });
  if (!provider) throw new HttpError(404, "Provider not found.");
  const reviews = await db.review.findMany({
    where: { providerId: provider.id, status: "PUBLISHED" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      rating: true,
      body: true,
      createdAt: true,
      providerReply: true,
      customer: { select: { name: true } },
      staff: { select: { name: true } },
      photos: { select: { id: true } },
    },
  });
  const total = await db.review.count({ where: { providerId: provider.id, status: "PUBLISHED" } });
  return { reviews, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function adminReviewQueue() {
  return db.review.findMany({
    where: { OR: [{ status: { in: ["HIDDEN", "DELETED"] } }, { reports: { some: { resolvedAt: null } } }] },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: {
      customer: { select: { name: true, email: true } },
      provider: { select: { displayName: true } },
      staff: { select: { name: true } },
      reports: { where: { resolvedAt: null }, include: { reporter: { select: { name: true } } } },
    },
  });
}

export async function moderateReview(
  actorId: string,
  id: string,
  input: z.infer<typeof reviewModerationSchema>,
) {
  return db.$transaction(async (tx) => {
    const review = await tx.review.findUnique({
      where: { id },
      select: { id: true, providerId: true, staffId: true, status: true },
    });
    if (!review) throw new HttpError(404, "Review not found.");
    await tx.review.update({ where: { id }, data: { status: input.status as ReviewStatus } });
    await tx.reviewReport.updateMany({
      where: { reviewId: id, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: actorId },
    });
    await refreshRatings(tx, review.providerId, review.staffId);
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: id,
        action: "ADMIN_REVIEW_MODERATED",
        metadata: { from: review.status, to: input.status, reason: input.reason },
      },
    });
    return tx.review.findUniqueOrThrow({ where: { id }, select: { id: true, status: true } });
  });
}

export async function providerReviews(user: Viewer) {
  if (user.role !== "PROVIDER") throw new HttpError(403, "Provider access is required.");
  return db.review.findMany({
    where: { provider: { ownerId: user.id } },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { customer: { select: { name: true } }, staff: { select: { name: true } } },
  });
}
