import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { GatewayPayment } from "../src/lib/razorpay";

test("payment checkout and signed events preserve slot and wallet accounting", async (suite) => {
  const external = process.env.TEST_DATABASE_URL;
  let pg: PGlite | undefined;
  let socket: PGLiteSocketServer | undefined;
  if (external) process.env.DATABASE_URL = external;
  else {
    pg = await PGlite.create({ extensions: { btree_gist } });
    const dirs = await readdir("prisma/migrations", { withFileTypes: true });
    for (const name of dirs
      .filter((dir) => dir.isDirectory())
      .map((dir) => dir.name)
      .sort()) {
      await pg.exec(await readFile("prisma/migrations/" + name + "/migration.sql", "utf8"));
    }
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 1 });
    await socket.start();
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@" + socket.getServerConn() + "/postgres?connection_limit=1";
  }
  const { db } = await import("../src/lib/db");
  const {
    cancelAppointment,
    changeBooking,
    createBooking,
    previewCancellation,
    rescheduleBooking,
    rescheduleTimes,
  } = await import("../src/lib/bookings");
  const { processDueRefunds } = await import("../src/lib/refunds");
  const { overrideRefund } = await import("../src/lib/refunds");
  const { createGatewayOrder, receiveGatewayWebhook, verifyGatewayPayment } =
    await import("../src/lib/payments");
  const { expirePaymentHolds } = await import("../src/lib/payment-records");
  const { processPayouts, requestPayout, savePayoutDetails, getProviderFinance } =
    await import("../src/lib/finance");
  const { submitReview, replyToReview, reportReview, moderateReview, listPublicReviews } =
    await import("../src/lib/reviews");
  const { enqueueEvent, notificationCenter, markNotificationsRead } =
    await import("../src/lib/notifications");
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { name: "Fixture owner", role: "PROVIDER" } });
  const admin = await db.user.create({ data: { name: "Fixture admin", role: "ADMIN" } });
  const a = await db.user.create({ data: { name: "Fixture A", customer: { create: {} } } });
  const b = await db.user.create({ data: { name: "Fixture B", customer: { create: {} } } });
  const category = await db.serviceCategory.create({
    data: { id: suffix, name: "Fixture category", position: 999 },
  });
  const provider = await db.providerProfile.create({
    data: {
      ownerId: owner.id,
      slug: suffix,
      type: "SHOP",
      status: "APPROVED",
      displayName: "Payment test salon",
    },
  });
  const branch = await db.branch.create({
    data: { providerId: provider.id, name: "Main", address: "Kochi" },
  });
  const staff = await db.staff.create({
    data: {
      providerId: provider.id,
      branchId: branch.id,
      name: "Stylist",
      windows: {
        create: Array.from({ length: 7 }, (_, day) => ({
          dayOfWeek: day + 1,
          startMinute: 600,
          endMinute: 1080,
        })),
      },
    },
  });
  const service = await db.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      name: "Fixture cut",
      duration: 45,
      pricePaise: 10000,
      staff: { create: { staffId: staff.id } },
    },
  });
  await db.financeSetting.upsert({ where: { id: "platform" }, update: {}, create: { id: "platform" } });
  suite.after(async () => {
    if (external) {
      const bookings = await db.booking.findMany({
        where: { providerId: provider.id },
        select: { id: true },
      });
      const bookingIds = bookings.map(({ id }) => id);
      const userIds = [a.id, b.id, owner.id, admin.id];
      await db.notifications.deleteMany({
        where: { OR: [{ bookingId: { in: bookingIds } }, { userId: { in: userIds } }] },
      });
      await db.couponUsage.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.review.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.invoice.deleteMany({
        where: { bookingId: { in: bookingIds }, parentInvoiceId: { not: null } },
      });
      await db.invoice.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.coupon.deleteMany({ where: { createdById: admin.id } });
      const ledgerEntries = await db.ledgerEntry.findMany({
        where: { OR: [{ bookingId: { in: bookingIds } }, { providerId: provider.id }] },
        select: { batchId: true },
      });
      const ledgerBatchIds = [...new Set(ledgerEntries.map(({ batchId }) => batchId))];
      if (ledgerBatchIds.length) {
        await db.ledgerEntry.deleteMany({ where: { batchId: { in: ledgerBatchIds } } });
        await db.ledgerBatch.deleteMany({ where: { id: { in: ledgerBatchIds } } });
      }
      await db.payoutRequest.deleteMany({ where: { providerId: provider.id } });
      await db.auditLog.deleteMany({
        where: {
          OR: [{ targetId: { in: [...bookingIds, provider.id] } }, { actorId: { in: userIds } }],
        },
      });
      await db.gatewayEvent.deleteMany({ where: { id: { startsWith: suffix } } });
      await db.booking.deleteMany({ where: { providerId: provider.id } });
      await db.service.delete({ where: { id: service.id } });
      await db.staff.delete({ where: { id: staff.id } });
      await db.branch.delete({ where: { id: branch.id } });
      await db.providerProfile.delete({ where: { id: provider.id } });
      await db.serviceCategory.delete({ where: { id: category.id } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await db.$disconnect();
    await socket?.stop();
    await pg?.close();
  });

  const clock = Date.parse("2026-12-10T02:00:00.000Z");
  const selection = {
    providerId: provider.id,
    branchId: branch.id,
    staffId: staff.id,
    mode: "VENUE" as const,
    serviceIds: [service.id],
  };
  const input = (startsAt: string) => ({ ...selection, startsAt, requestKey: randomUUID() });
  const secret = "fixture-webhook-secret";
  const sign = (body: string | Buffer) => createHmac("sha256", secret).update(body).digest("hex");
  const gatewayOrder = (reference: string) => ({
    findOrder: async () => undefined,
    createOrder: async (receipt: string, amount: number) => ({
      id: "order_" + reference,
      receipt,
      amount,
      currency: "INR" as const,
    }),
  });
  const gatewayPayment = (payment: GatewayPayment) => ({ fetchPayment: async () => payment });
  const captured = (reference: string, order_id: string, amount: number): GatewayPayment => ({
    id: "pay_" + reference,
    order_id,
    amount,
    currency: "INR",
    status: "captured",
    fee: 200,
  });
  const send = (event: string, key: string, payload: object, payment: GatewayPayment, time = clock + 100) => {
    const body = Buffer.from(JSON.stringify({ event, payload }));
    return receiveGatewayWebhook(
      body,
      sign(body),
      suffix + "-" + key,
      gatewayPayment(payment),
      secret,
      new Date(time),
    );
  };

  await suite.test("out-of-order refund, capture, failure and verification are idempotent", async () => {
    const slot = input("2026-12-11T04:30:00.000Z");
    const booked = await createBooking(a.id, { ...slot, paymentMode: "FULL_ONLINE" }, clock);
    const reference = booked.booking.id;
    const order = await createGatewayOrder(reference, a.id, gatewayOrder(reference), new Date(clock));
    assert.deepEqual(
      await createGatewayOrder(reference, a.id, gatewayOrder("unused"), new Date(clock)),
      order,
    );
    const payment = captured(reference, order.orderId, order.amount);
    const refund = {
      id: "rfnd_" + reference,
      payment_id: payment.id,
      amount: 2000,
      currency: "INR",
      status: "processed",
    };
    const first = await send("refund.processed", "refund", { refund: { entity: refund } }, payment);
    assert.equal(first.duplicate, false);
    const duplicates = await Promise.all([
      send("refund.processed", "refund", { refund: { entity: refund } }, payment),
      send("payment.captured", "capture", { payment: { entity: payment } }, payment),
      send("payment.failed", "failure", { payment: { entity: { ...payment, status: "failed" } } }, payment),
    ]);
    assert.equal(duplicates[0].duplicate, true);
    const verified = await verifyGatewayPayment(
      a.id,
      {
        bookingId: reference,
        orderId: order.orderId,
        paymentId: payment.id,
        signature: sign(order.orderId + "|" + payment.id),
      },
      gatewayPayment(payment),
      secret,
      new Date(clock + 100),
    );
    assert.deepEqual(verified, { status: "PARTIALLY_REFUNDED", bookingStatus: "CONFIRMED" });
    assert.equal(await db.refund.count({ where: { payment: { bookingId: reference } } }), 1);
    assert.equal(await db.auditLog.count({ where: { targetId: reference, action: "PAYMENT_CAPTURED" } }), 1);
  });

  await suite.test(
    "a competing hold blocks the slot, expiry releases it, and late capture credits once",
    async () => {
      const slot = "2026-12-12T04:30:00.000Z";
      await db.wallet.create({ data: { userId: b.id, balancePaise: 500 } });
      const booked = await createBooking(
        b.id,
        { ...input(slot), paymentMode: "DEPOSIT", useWallet: true },
        clock,
      );
      const reference = booked.booking.id;
      assert.equal(booked.booking.payment?.gatewayAmountPaise, 2000);
      const order = await createGatewayOrder(reference, b.id, gatewayOrder(reference), new Date(clock));
      await assert.rejects(createBooking(a.id, input(slot), clock + 1), { status: 409 });
      const late = clock + 600_001;
      assert.equal(await expirePaymentHolds(new Date(late)), 1);
      assert.equal(await expirePaymentHolds(new Date(late)), 0);
      const replacement = await createBooking(a.id, input(slot), late);
      const payment = captured(reference, order.orderId, order.amount);
      await Promise.all([
        send("payment.captured", "late-a", { payment: { entity: payment } }, payment, late),
        send("payment.captured", "late-b", { payment: { entity: payment } }, payment, late),
      ]);
      const saved = await db.payment.findUniqueOrThrow({
        where: { bookingId: reference },
        include: { booking: true },
      });
      assert.equal(saved.booking.status, "CANCELLED");
      assert.equal(saved.status, "REFUNDED");
      assert.equal((await db.wallet.findUniqueOrThrow({ where: { userId: b.id } })).balancePaise, 2500);
      assert.equal(replacement.booking.status, "CONFIRMED");
    },
  );

  await suite.test("a provider cancellation queues a full original refund, processed once", async () => {
    const booked = await createBooking(
      a.id,
      { ...input("2026-12-13T04:30:00.000Z"), paymentMode: "FULL_ONLINE" },
      clock,
    );
    const id = booked.booking.id;
    const order = await createGatewayOrder(id, a.id, gatewayOrder(id), new Date(clock));
    const paid = captured(id, order.orderId, order.amount);
    await send("payment.captured", "cancel-capture", { payment: { entity: paid } }, paid);
    const quote = await previewCancellation(id, owner, clock + 200);
    assert.equal(quote.refundPaise, 10_000);
    const cancel = {
      requestKey: randomUUID(),
      destination: "ORIGINAL" as const,
      expectedRefundPaise: quote.refundPaise,
    };
    await cancelAppointment(id, owner, cancel, clock + 200);
    await cancelAppointment(id, owner, cancel, clock + 200);
    const refund = await db.refund.findFirstOrThrow({ where: { payment: { bookingId: id } } });
    const delivered = {
      id: "rfnd_" + id,
      payment_id: paid.id,
      amount: 10_000,
      currency: "INR" as const,
      status: "processed",
      notes: { refund_id: refund.id },
    };
    let requests = 0;
    const mock = {
      refund: async () => {
        requests++;
        return delivered;
      },
      fetchRefund: async () => delivered,
    };
    await Promise.all([
      processDueRefunds(mock, new Date(clock + 300)),
      processDueRefunds(mock, new Date(clock + 300)),
    ]);
    assert.equal(requests, 1);
    await send("refund.processed", "original-refund", { refund: { entity: delivered } }, paid);
    assert.equal(await db.refund.count({ where: { payment: { bookingId: id }, status: "PROCESSED" } }), 1);
  });

  await suite.test(
    "rescheduling carries prepayment to a new price and credits excess only once",
    async () => {
      const booked = await createBooking(
        a.id,
        { ...input("2026-12-14T04:30:00.000Z"), paymentMode: "FULL_ONLINE" },
        clock,
      );
      const id = booked.booking.id;
      const order = await createGatewayOrder(id, a.id, gatewayOrder(id), new Date(clock));
      const paid = captured(id, order.orderId, order.amount);
      await send("payment.captured", "move-capture", { payment: { entity: paid } }, paid);
      const originalReminders = await db.notifications.findMany({
        where: { bookingId: id, eventType: "BOOKING_REMINDER", status: "QUEUED" },
        select: { id: true, idempotencyKey: true },
      });
      assert.ok(originalReminders.length > 0);
      await db.service.update({ where: { id: service.id }, data: { pricePaise: 8000 } });
      const quote = await rescheduleTimes(id, a, "2026-12-15", clock + 100);
      assert.equal(quote.price.refundPaise, 2000);
      const move = {
        startsAt: "2026-12-15T04:30:00.000Z",
        requestKey: randomUUID(),
        expectedTotalPaise: 8000,
      };
      const after = await rescheduleBooking(id, a, move, clock + 100);
      assert.equal(after.totalPaise, 8000);
      assert.equal(after.payment?.dueAtVenuePaise, 0);
      await rescheduleBooking(id, a, move, clock + 100);
      assert.equal((await db.wallet.findUniqueOrThrow({ where: { userId: a.id } })).balancePaise, 2000);
      const originalStatuses = await db.notifications.findMany({
        where: { id: { in: originalReminders.map(({ id: notificationId }) => notificationId) } },
        select: { status: true },
      });
      assert.ok(originalStatuses.every(({ status }) => status === "CANCELLED"));
      const replacementReminders = await db.notifications.findMany({
        where: {
          bookingId: id,
          eventType: "BOOKING_REMINDER",
          status: "QUEUED",
          idempotencyKey: { notIn: originalReminders.map(({ idempotencyKey }) => idempotencyKey) },
        },
      });
      assert.ok(replacementReminders.length > 0);
    },
  );

  await suite.test("a coupon use limit remains safe across simultaneous bookings", async () => {
    await db.service.update({ where: { id: service.id }, data: { pricePaise: 10_000 } });
    const code = "RACE" + suffix.replaceAll("-", "").slice(0, 8).toUpperCase();
    await db.coupon.create({
      data: {
        code,
        kind: "PERCENT",
        discountType: "PERCENT",
        funding: "PLATFORM",
        createdById: admin.id,
        amount: 1000,
        maxDiscountPaise: 5000,
        minCartPaise: 0,
        totalUses: 1,
        perUserLimit: 1,
        validFrom: new Date(clock - 60_000),
        validUntil: new Date(clock + 30 * 86_400_000),
      },
    });
    const outcomes = await Promise.allSettled([
      createBooking(a.id, { ...input("2026-12-16T04:30:00.000Z"), couponCode: code }, clock),
      createBooking(b.id, { ...input("2026-12-17T04:30:00.000Z"), couponCode: code }, clock),
    ]);
    const successes = outcomes.filter((result) => result.status === "fulfilled");
    const failures = outcomes.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    if (successes[0].status === "fulfilled") assert.equal(successes[0].value.booking.discountPaise, 1000);
    if (failures[0].status === "rejected") assert.equal(failures[0].reason.code, "COUPON_INVALID");
    assert.equal((await db.coupon.findUniqueOrThrow({ where: { code } })).usageCount, 1);
    assert.equal(await db.couponUsage.count({ where: { coupon: { code }, status: "RESERVED" } }), 1);
  });

  await suite.test(
    "completed finance, invoice, review, notifications and post-payout refunds reconcile",
    async () => {
      process.env.DATA_SECRET = "phase-two-integration-data-secret-at-least-32-characters";
      await db.service.update({ where: { id: service.id }, data: { pricePaise: 120_000 } });
      await db.providerProfile.update({
        where: { id: provider.id },
        data: {
          gstRegistered: true,
          gstin: "32ABCDE1234F1Z5",
          gstRateBps: 1800,
        },
      });
      const startsAt = "2026-12-18T04:30:00.000Z";
      const booked = await createBooking(a.id, { ...input(startsAt), paymentMode: "FULL_ONLINE" }, clock);
      const id = booked.booking.id;
      const order = await createGatewayOrder(id, a.id, gatewayOrder(id), new Date(clock));
      const paid = captured(id, order.orderId, order.amount);
      await send("payment.captured", "finance-capture", { payment: { entity: paid } }, paid);
      const completionAt = Date.parse(startsAt) + 45 * 60_000;
      await changeBooking(id, owner, "IN_PROGRESS", Date.parse(startsAt));
      await changeBooking(id, owner, "COMPLETED", completionAt);

      const completionBatch = await db.ledgerBatch.findUniqueOrThrow({
        where: { reference: "booking-completion:" + id },
        include: { entries: true },
      });
      assert.equal(
        completionBatch.entries.find((entry) => entry.account === "TAX_PAYABLE")?.amountPaise,
        -booked.booking.taxPaise,
      );
      const prePayoutFinance = await getProviderFinance(provider.id);
      assert.equal(typeof prePayoutFinance, "object");
      if (typeof prePayoutFinance !== "string") {
        assert.equal(prePayoutFinance.balance.taxPayablePaise, booked.booking.taxPaise);
      }

      const invoices = await db.invoice.findMany({ where: { bookingId: id }, orderBy: { kind: "asc" } });
      assert.equal(invoices.filter((invoice) => invoice.kind === "CUSTOMER").length, 1);
      assert.equal(invoices.filter((invoice) => invoice.kind === "PLATFORM_COMMISSION").length, 1);
      const { renderInvoicePdf } = await import("../src/lib/invoices");
      assert.equal(renderInvoicePdf(invoices[0]).subarray(0, 8).toString("ascii"), "%PDF-1.4");

      const customerViewer = {
        id: a.id,
        name: a.name,
        email: a.email,
        phone: a.phone,
        role: "CUSTOMER" as const,
      };
      const providerViewer = {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        role: "PROVIDER" as const,
      };
      const reviewNow = new Date(completionAt + 1000);
      const review = await submitReview(
        customerViewer,
        { bookingId: id, rating: 5, body: "A polished finish and a thoughtful visit." },
        [],
        reviewNow,
      );
      await submitReview(
        customerViewer,
        { bookingId: id, rating: 4, body: "A polished finish and a thoughtful visit." },
        [],
        reviewNow,
      );
      assert.equal(await db.review.count({ where: { bookingId: id } }), 1);
      assert.equal((await db.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).rating, 4);
      assert.equal((await listPublicReviews(provider.slug, 1)).total, 1);
      await replyToReview(providerViewer, review.id, { reply: "Thank you for visiting us." });
      await assert.rejects(replyToReview(providerViewer, review.id, { reply: "A second reply." }), {
        status: 409,
      });
      await reportReview({ ...customerViewer, id: b.id, name: b.name }, review.id, {
        reason: "Please review this customer comment.",
      });
      await moderateReview(admin.id, review.id, {
        status: "HIDDEN",
        reason: "Hidden for the moderation workflow test.",
      });
      assert.equal(
        (await db.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).reviewCount,
        0,
      );

      const { getLoyaltyPoints } = await import("../src/lib/rewards");
      const points = await db.$transaction((tx) => getLoyaltyPoints(tx, a.id, reviewNow));
      assert.ok(points > 0);
      const notificationKey = "phase-two-notification:" + suffix;
      await db.$transaction(async (tx) => {
        const payload = {
          userId: a.id,
          eventType: "BOOKING_REMINDER",
          title: "Appointment reminder",
          body: "Your appointment is approaching.",
          idempotencyKey: notificationKey,
          channels: ["IN_APP" as const],
        };
        await enqueueEvent(tx, payload);
        await enqueueEvent(tx, payload);
      });
      const notice = await db.notifications.findUniqueOrThrow({
        where: { idempotencyKey: notificationKey + ":IN_APP" },
      });
      assert.equal(notice.status, "SENT");
      const center = await notificationCenter(a.id);
      assert.ok(center.notifications.some(({ id: notificationId }) => notificationId === notice.id));
      assert.equal((await markNotificationsRead(a.id, [notice.id])).updated, 1);
      assert.ok((await db.notifications.findUniqueOrThrow({ where: { id: notice.id } })).readAt);

      await savePayoutDetails(provider.id, { type: "UPI", upiId: "fixture@upi" }, owner.id);
      const payout = await requestPayout(
        provider.id,
        { requestKey: randomUUID(), amountPaise: 50_000 },
        owner.id,
        new Date(clock),
      );
      assert.equal(payout.eligibleAt.getTime(), clock + 7 * 24 * 60 * 60 * 1000);
      await assert.rejects(
        processPayouts(
          admin.id,
          { payoutIds: [payout.id], action: "APPROVE" },
          new Date(payout.eligibleAt.getTime() - 1),
        ),
        /configured payout cycle/,
      );
      await processPayouts(admin.id, { payoutIds: [payout.id], action: "APPROVE" }, payout.eligibleAt);
      await processPayouts(
        admin.id,
        {
          payoutIds: [payout.id],
          action: "MARK_PAID",
          reference: "fixture-bank-transfer-" + suffix,
        },
        payout.eligibleAt,
      );
      const retryPayout = await requestPayout(
        provider.id,
        { requestKey: randomUUID(), amountPaise: 50_000 },
        owner.id,
        new Date(clock),
      );
      await processPayouts(
        admin.id,
        {
          payoutIds: [retryPayout.id],
          action: "REJECT",
          reason: "Temporary test payout rejection.",
        },
        retryPayout.eligibleAt,
      );
      assert.equal(
        (await db.payoutRequest.findUniqueOrThrow({ where: { id: retryPayout.id } })).status,
        "FAILED",
      );
      await processPayouts(
        admin.id,
        { payoutIds: [retryPayout.id], action: "RETRY" },
        retryPayout.eligibleAt,
      );
      assert.equal(
        (await db.payoutRequest.findUniqueOrThrow({ where: { id: retryPayout.id } })).status,
        "APPROVED",
      );
      await processPayouts(
        admin.id,
        {
          payoutIds: [retryPayout.id],
          action: "MARK_PAID",
          reference: "fixture-bank-retry-" + suffix,
        },
        retryPayout.eligibleAt,
      );
      const refund = await overrideRefund(admin.id, {
        bookingId: id,
        requestKey: randomUUID(),
        amountPaise: 120_000,
        destination: "WALLET",
        reason: "Refund after the test payout was marked paid.",
      });
      assert.equal(refund.status, "PROCESSED");
      const finance = await getProviderFinance(provider.id);
      assert.equal(typeof finance, "object");
      if (typeof finance !== "string") {
        assert.ok(finance.balance.payablePaise < 0);
        assert.equal(finance.balance.availablePaise, 0);
      }
      const creditNotes = await db.invoice.count({ where: { bookingId: id, kind: "CREDIT_NOTE" } });
      assert.equal(creditNotes, 2);
      const batches = await db.ledgerBatch.findMany({
        where: { entries: { some: { bookingId: id } } },
        include: { entries: true },
      });
      assert.ok(batches.length >= 3);
      for (const batch of batches) {
        assert.equal(
          batch.entries.reduce((sum, entry) => sum + entry.amountPaise, 0),
          0,
        );
      }
      const payoutBatch = await db.ledgerBatch.findUniqueOrThrow({
        where: { reference: "payout:" + payout.id },
        include: { entries: true },
      });
      assert.equal(
        payoutBatch.entries.find((entry) => entry.account === "TAX_PAYABLE")?.amountPaise,
        booked.booking.taxPaise,
      );
      assert.equal(
        payoutBatch.entries.reduce((sum, entry) => sum + entry.amountPaise, 0),
        0,
      );
    },
  );
});
