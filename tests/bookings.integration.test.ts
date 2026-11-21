import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

test("booking and provider workflows preserve availability and access rules", async (suite) => {
  const external = process.env.TEST_DATABASE_URL;
  let pg: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;
  if (external) {
    process.env.DATABASE_URL = external;
  } else {
    pg = await PGlite.create({ extensions: { btree_gist } });
    const migrations = await readdir("prisma/migrations", { withFileTypes: true });
    for (const directory of migrations
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort()) {
      await pg.exec(await readFile(join("prisma/migrations", directory, "migration.sql"), "utf8"));
    }
    server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 1 });
    await server.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1`;
  }
  const { db } = await import("../src/lib/db");
  const {
    changeBooking,
    createBooking,
    createWalkIn,
    getAvailability,
    listBookings,
    rescheduleBooking,
    rescheduleTimes,
  } = await import("../src/lib/bookings");
  const { MINUTE, reservation } = await import("../src/lib/schedule");
  const { reviewProvider } = await import("../src/lib/provider");
  const suffix = randomUUID();
  const customer = (name: string) =>
    db.user.create({ data: { name, role: "CUSTOMER", customer: { create: {} } } });
  const [first, second, third, owner, admin, category] = await Promise.all([
    customer("Test customer A"),
    customer("Test customer B"),
    customer("Test customer C"),
    db.user.create({ data: { name: "Test provider", role: "PROVIDER" } }),
    db.user.create({ data: { name: "Test admin", role: "ADMIN" } }),
    db.serviceCategory.create({ data: { id: suffix, name: "Test category", position: 90 } }),
  ]);
  const provider = await db.providerProfile.create({
    data: {
      ownerId: owner.id,
      displayName: "Test studio",
      slug: `integration-${suffix}`,
      type: "SHOP",
      status: "PENDING",
      cancelBeforeHours: 2,
      autoConfirm: false,
      homeEnabled: true,
      travelRadiusKm: 12,
      travelBasePaise: 12500,
      travelPerKmPaise: 2500,
      travelMinutesPerKm: 5,
    },
  });
  suite.after(async () => {
    if (external) {
      const guests = await db.booking.findMany({
        where: { providerId: provider.id, walkInKey: { not: null } },
        select: { customerId: true },
      });
      const userIds = [
        first.id,
        second.id,
        third.id,
        owner.id,
        admin.id,
        ...guests.map(({ customerId }) => customerId),
      ];
      const bookingIds = await db.booking
        .findMany({ where: { providerId: provider.id }, select: { id: true } })
        .then((rows) => rows.map(({ id }) => id));
      await db.notifications.deleteMany({
        where: { OR: [{ bookingId: { in: bookingIds } }, { userId: { in: userIds } }] },
      });
      await db.couponUsage.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.review.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.invoice.deleteMany({
        where: { bookingId: { in: bookingIds }, parentInvoiceId: { not: null } },
      });
      await db.invoice.deleteMany({ where: { bookingId: { in: bookingIds } } });
      const entries = await db.ledgerEntry.findMany({
        where: { OR: [{ bookingId: { in: bookingIds } }, { providerId: provider.id }] },
        select: { batchId: true },
      });
      const batchIds = [...new Set(entries.map(({ batchId }) => batchId))];
      if (batchIds.length) {
        await db.ledgerEntry.deleteMany({ where: { batchId: { in: batchIds } } });
        await db.ledgerBatch.deleteMany({ where: { id: { in: batchIds } } });
      }
      await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await db.booking.deleteMany({ where: { providerId: provider.id } });
      await db.service.deleteMany({ where: { providerId: provider.id } });
      await db.staff.deleteMany({ where: { providerId: provider.id } });
      await db.branch.deleteMany({ where: { providerId: provider.id } });
      await db.providerProfile.delete({ where: { id: provider.id } });
      await db.serviceCategory.delete({ where: { id: category.id } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await db.$disconnect();
    await server?.stop();
    await pg?.close();
  });
  const branch = await db.branch.create({
    data: { providerId: provider.id, name: "Main", address: "Kochi", latitude: 10, longitude: 76 },
  });
  const hours = Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    kind: "WORK" as const,
    startMinute: 600,
    endMinute: 1080,
  }));
  const staff = await db.staff.create({
    data: {
      name: "One bookable stylist",
      providerId: provider.id,
      branchId: branch.id,
      windows: { create: hours },
    },
  });
  const service = await db.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      name: "Ceremony styling",
      duration: 45,
      buffer: 15,
      pricePaise: 120_000,
      homeEligible: true,
      staff: { create: { staffId: staff.id } },
    },
  });
  const base = {
    providerId: provider.id,
    branchId: branch.id,
    staffId: staff.id,
    serviceIds: [service.id],
    mode: "VENUE" as const,
  };
  const clock = Date.parse("2026-11-20T02:00:00Z");
  const date = "2026-11-21";
  const startsAt = "2026-11-21T04:30:00.000Z";
  const bookingInput = { ...base, startsAt, requestKey: randomUUID() };
  let bookingId: string;

  await suite.test("pending providers are hidden and approval creates an audit event", async () => {
    await assert.rejects(getAvailability({ ...base, date }, clock), { status: 404 });
    await reviewProvider(admin, { providerId: provider.id, status: "APPROVED" });
    const latest = await db.auditLog.findFirst({ where: { targetId: provider.id } });
    assert.equal(latest?.action, "PROVIDER_REVIEW");
    const slots = await getAvailability({ ...base, date }, clock);
    assert.equal(slots.slots[0].startsAt.toISOString(), startsAt);
    assert.equal(slots.totalPaise, 120_000);
  });

  await suite.test("competing customers cannot book the same interval", async () => {
    const outcomes = await Promise.allSettled([
      createBooking(first.id, bookingInput, clock),
      createBooking(second.id, { ...bookingInput, requestKey: randomUUID() }, clock),
    ]);
    const successes = outcomes.filter((entry) => entry.status === "fulfilled");
    assert.equal(successes.length, 1);
    assert.equal(
      outcomes.filter((entry) => entry.status === "rejected" && entry.reason.code === "SLOT_UNAVAILABLE")
        .length,
      1,
    );
    const booked = successes[0].value.booking;
    bookingId = booked.id;
    assert.equal(booked.status, "PENDING");
    assert.equal(booked.totalPaise, 120_000);
    assert.equal(booked.items[0].name, service.name);
    assert.equal(+booked.reservedUntil - +booked.endsAt, 15 * 60_000);
  });

  await suite.test("a stale price quote requires customer confirmation", async () => {
    await assert.rejects(
      createBooking(
        first.id,
        {
          ...bookingInput,
          startsAt: "2026-11-21T06:30:00.000Z",
          requestKey: randomUUID(),
          expectedTotalPaise: 100_000,
        },
        clock,
      ),
      { status: 409, code: "PRICE_CHANGED" },
    );
  });

  await suite.test("idempotency returns the original booking, and overlap is rejected in SQL", async () => {
    const original = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const replay = await createBooking(
      original.customerId,
      { ...bookingInput, requestKey: original.requestKey },
      clock,
    );
    assert.equal(replay.created, false);
    assert.equal(replay.booking.id, original.id);
    await assert.rejects(
      createBooking(
        original.customerId,
        { ...bookingInput, requestKey: original.requestKey, startsAt: "2026-11-21T06:30:00.000Z" },
        clock,
      ),
      { code: "REQUEST_KEY_REUSED" },
    );
    const overlapping = { ...original, id: randomUUID(), requestKey: randomUUID() };
    await assert.rejects(db.booking.create({ data: overlapping }), /booking_staff_overlap|23P01/);
  });

  await suite.test("only participants can change a booking and cancellation releases the slot", async () => {
    const booked = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const [buyer, stranger] = booked.customerId === first.id ? [first, second] : [second, first];
    await assert.rejects(changeBooking(bookingId, stranger, "CANCELLED", clock), { status: 404 });
    await assert.rejects(changeBooking(bookingId, buyer, "CONFIRMED", clock), { status: 403 });
    assert.equal((await changeBooking(bookingId, owner, "CONFIRMED", clock)).status, "CONFIRMED");
    const newStart = "2026-11-21T06:00:00.000Z";
    assert.ok(
      (await rescheduleTimes(bookingId, buyer, date, clock)).slots.find(
        (slot) => slot.toISOString() === newStart,
      ),
    );
    const updated = await rescheduleBooking(bookingId, buyer, { startsAt: newStart }, clock);
    assert.equal(updated.startsAt.toISOString(), newStart);
    await assert.rejects(changeBooking(bookingId, buyer, "CANCELLED", Date.parse(newStart) - 60_000), {
      status: 409,
    });
    const cancelled = await changeBooking(bookingId, buyer, "CANCELLED", clock);
    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(
      (await getAvailability({ ...base, date }, clock)).slots.some(
        (slot) => slot.startsAt.toISOString() === newStart,
      ),
    );
  });

  await suite.test("home visits enforce the radius, add a travel fee, and reserve travel time", async () => {
    const location = { address: "Home near studio", latitude: 10.02, longitude: 76 };
    const home = { ...base, mode: "HOME" as const, location };
    await assert.rejects(
      getAvailability({ ...home, location: { ...location, latitude: 10.5 }, date }, clock),
      { status: 400 },
    );
    const availability = await getAvailability({ ...home, date }, clock);
    assert.ok(availability.travelPaise > 12_500);
    const slot = availability.slots[0].startsAt;
    const booked = await createBooking(
      first.id,
      { ...home, startsAt: slot.toISOString(), requestKey: randomUUID() },
      clock,
    );
    assert.equal(booked.booking.totalPaise, availability.totalPaise);
    assert.ok(booked.booking.reservedFrom < booked.booking.startsAt);
    assert.ok(+booked.booking.reservedUntil - +booked.booking.endsAt > 15 * 60_000);
  });

  await suite.test("outside hours, breaks, time off and holidays cannot be booked", async () => {
    const regular = "2026-11-23";
    const holiday = "2026-11-24";
    await db.availabilityWindow.create({
      data: { staffId: staff.id, kind: "BREAK", dayOfWeek: 1, startMinute: 780, endMinute: 840 },
    });
    await db.timeOff.create({
      data: {
        staffId: staff.id,
        startsAt: new Date(`${regular}T10:30:00+05:30`),
        endsAt: new Date(`${regular}T11:30:00+05:30`),
      },
    });
    await db.branchHoliday.create({
      data: { branchId: branch.id, date: holiday, reason: "Test branch closure" },
    });

    const times = (await getAvailability({ ...base, date: regular }, clock)).slots.map((slot) =>
      slot.startsAt.toISOString(),
    );
    assert.ok(
      times.includes(new Date(`${regular}T11:30:00+05:30`).toISOString()),
      "A booking starting after time off must be available",
    );
    assert.ok(
      times.includes(new Date(`${regular}T12:00:00+05:30`).toISOString()),
      "A booking ending at the break boundary must be available",
    );
    assert.deepEqual((await getAvailability({ ...base, date: holiday }, clock)).slots, []);

    const invalidStarts = [
      `${regular}T09:45:00+05:30`,
      `${regular}T10:45:00+05:30`,
      `${regular}T12:15:00+05:30`,
      `${regular}T13:15:00+05:30`,
      `${regular}T17:15:00+05:30`,
      `${holiday}T11:00:00+05:30`,
    ];
    for (const blockedStart of invalidStarts) {
      assert.ok(!times.includes(new Date(blockedStart).toISOString()));
      await assert.rejects(
        createBooking(first.id, { ...base, startsAt: blockedStart, requestKey: randomUUID() }, clock),
        { status: 409, code: "SLOT_UNAVAILABLE" },
      );
    }
  });

  await suite.test("combined services include intermediate buffer and reserve final cleanup", async () => {
    const secondService = await db.service.create({
      data: {
        providerId: provider.id,
        categoryId: category.id,
        name: "Second service",
        kind: "ADD_ON",
        duration: 20,
        buffer: 5,
        pricePaise: 25_000,
        staff: { create: { staffId: staff.id } },
      },
    });
    const services = { ...base, serviceIds: [service.id, secondService.id] };
    const combinedDate = "2026-11-26";
    const availability = await getAvailability({ ...services, date: combinedDate }, clock);
    assert.equal(availability.totalPaise, 145_000);
    assert.equal(availability.duration, 45 + 15 + 20);
    const slot = availability.slots[0].startsAt.toISOString();
    const result = await createBooking(
      first.id,
      { ...services, startsAt: slot, requestKey: randomUUID() },
      clock,
    );
    assert.deepEqual(
      result.booking.items.map(({ serviceId }) => serviceId),
      services.serviceIds,
    );
    assert.equal(+result.booking.endsAt - +result.booking.startsAt, 80 * MINUTE);
    assert.equal(+result.booking.reservedUntil - +result.booking.endsAt, 5 * MINUTE);
    await assert.rejects(
      createBooking(
        second.id,
        {
          ...base,
          startsAt: new Date(+result.booking.startsAt + 75 * MINUTE).toISOString(),
          requestKey: randomUUID(),
        },
        clock,
      ),
      { status: 409, code: "SLOT_UNAVAILABLE" },
    );
    const after = await getAvailability({ ...base, date: combinedDate }, clock);
    assert.equal(+after.slots[0].startsAt - +result.booking.startsAt, 90 * MINUTE);
  });

  const alternate = await db.staff.create({
    data: {
      name: "Second eligible professional",
      providerId: provider.id,
      branchId: branch.id,
      windows: { create: hours },
      services: { create: { serviceId: service.id } },
    },
  });
  const unqualified = await db.staff.create({
    data: {
      name: "Professional without the selected assignment",
      providerId: provider.id,
      branchId: branch.id,
      windows: { create: hours },
    },
  });

  await suite.test(
    "any available selects only eligible professionals and respects their joint capacity",
    async () => {
      const anyStaff = { ...base, staffId: undefined };
      const anyDate = "2026-11-27";
      const { slots } = await getAvailability({ ...anyStaff, date: anyDate }, clock);
      assert.equal(slots[0].staffCount, 2);
      const start = slots[0].startsAt.toISOString();
      const outcomes = await Promise.allSettled(
        [first, second, third].map(({ id }) =>
          createBooking(id, { ...anyStaff, startsAt: start, requestKey: randomUUID() }, clock),
        ),
      );
      const accepted = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value.booking.staffId] : [],
      );
      assert.deepEqual(accepted.sort(), [staff.id, alternate.id].sort());
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, "SLOT_UNAVAILABLE");
      assert.ok(
        !(await getAvailability({ ...anyStaff, date: anyDate }, clock)).slots.some(
          (slot) => slot.startsAt.toISOString() === start,
        ),
      );
    },
  );

  await suite.test("existing appointments retain rescheduling after removal from the catalog", async () => {
    const selected = "2026-11-28";
    const scheduled = await createBooking(
      first.id,
      {
        ...base,
        startsAt: `${selected}T10:00:00+05:30`,
        requestKey: randomUUID(),
      },
      clock,
    );
    const id = scheduled.booking.id;
    try {
      await db.service.update({ where: { id: service.id }, data: { active: false } });
      await db.serviceStaff.delete({
        where: { serviceId_staffId: { serviceId: service.id, staffId: staff.id } },
      });
      await assert.rejects(getAvailability({ ...base, date: selected }, clock), { status: 400 });
      const replacement = (await rescheduleTimes(id, first, selected, clock)).slots[1];
      await assert.rejects(
        rescheduleBooking(id, first, { startsAt: replacement.toISOString(), staffId: unqualified.id }, clock),
        { status: 409, code: "SLOT_UNAVAILABLE" },
      );
      await assert.rejects(
        rescheduleBooking(id, first, { startsAt: replacement.toISOString(), staffId: alternate.id }, clock),
        { status: 409, code: "SLOT_UNAVAILABLE" },
      );
      const moved = await rescheduleBooking(id, first, { startsAt: replacement.toISOString() }, clock);
      assert.equal(+moved.startsAt, +replacement);
      assert.equal(moved.staffId, staff.id);
      assert.equal(moved.totalPaise, scheduled.booking.totalPaise);
      assert.equal(
        +moved.reservedUntil - +moved.startsAt,
        +scheduled.booking.reservedUntil - +scheduled.booking.startsAt,
      );
    } finally {
      await db.service.update({
        where: { id: service.id },
        data: {
          active: true,
          staff: {
            connectOrCreate: {
              where: { serviceId_staffId: { serviceId: service.id, staffId: staff.id } },
              create: { staffId: staff.id },
            },
          },
        },
      });
    }
  });

  await suite.test(
    "confirmed appointments can be started and completed or marked no-show after their start",
    async () => {
      const firstTime = "2026-12-01T10:00:00+05:30";
      const secondTime = "2026-12-01T12:00:00+05:30";
      const cases = [
        { time: firstTime, action: "IN_PROGRESS" as const, next: "COMPLETED" as const },
        { time: secondTime, action: "NO_SHOW" as const, next: undefined },
      ];
      for (const { time, action, next } of cases) {
        const { booking } = await createBooking(
          first.id,
          { ...base, startsAt: time, requestKey: randomUUID() },
          clock,
        );
        await changeBooking(booking.id, owner, "CONFIRMED", clock);
        await assert.rejects(changeBooking(booking.id, owner, action, clock), { status: 409 });
        assert.equal((await changeBooking(booking.id, owner, action, Date.parse(time))).status, action);
        if (next)
          assert.equal(
            (await changeBooking(booking.id, owner, next, Date.parse(time) + 60 * MINUTE)).status,
            next,
          );
        await assert.rejects(changeBooking(booking.id, owner, "CANCELLED", Date.parse(time) + 60 * MINUTE), {
          status: 409,
        });
      }
    },
  );

  await suite.test(
    "walk-ins reserve immediately, isolate roles and retry without duplicating guests",
    async () => {
      const { providerId, branchId, staffId, serviceIds } = base;
      const walkIn = {
        providerId,
        branchId,
        staffId,
        serviceIds,
        requestKey: randomUUID(),
        customerName: "Walk-in guest",
      };
      const walkInStart = Date.parse("2026-12-02T10:02:12.000+05:30");
      await assert.rejects(createWalkIn(first, walkIn, walkInStart), { status: 403 });
      await assert.rejects(createWalkIn(owner, walkIn, Date.parse("2026-11-24T11:00:00+05:30")), {
        status: 409,
      });
      await assert.rejects(createWalkIn(owner, walkIn, Date.parse("2026-11-23T13:10:00+05:30")), {
        status: 409,
      });
      await assert.rejects(createWalkIn(owner, walkIn, Date.parse("2026-12-02T08:30:00+05:30")), {
        status: 409,
      });
      const created = await createWalkIn(owner, walkIn, walkInStart);
      assert.equal(created.booking.status, "IN_PROGRESS");
      assert.equal(+created.booking.startsAt, walkInStart);
      const guest = await db.user.findUniqueOrThrow({ where: { id: created.booking.customerId } });
      assert.deepEqual([guest.email, guest.phone, guest.passwordHash], [null, null, null]);
      const replay = await createWalkIn(owner, walkIn, walkInStart + 20 * MINUTE);
      assert.equal(replay.created, false);
      assert.equal(replay.booking.id, created.booking.id);
      await assert.rejects(createWalkIn(owner, { ...walkIn, customerName: "Different guest" }, walkInStart), {
        status: 409,
        code: "REQUEST_KEY_REUSED",
      });
      await assert.rejects(
        createWalkIn(owner, { ...walkIn, requestKey: randomUUID() }, walkInStart + MINUTE),
        { status: 409, code: "SLOT_UNAVAILABLE" },
      );
      await assert.rejects(
        createBooking(
          second.id,
          { ...base, startsAt: "2026-12-02T10:15:00+05:30", requestKey: randomUUID() },
          clock,
        ),
        { status: 409, code: "SLOT_UNAVAILABLE" },
      );
      const daily = await listBookings(owner, {
        branchId: branch.id,
        from: new Date(walkInStart - 30 * MINUTE),
        until: new Date(walkInStart + 30 * MINUTE),
      });
      assert.deepEqual(
        daily.map(({ id }) => id),
        [created.booking.id],
      );
      assert.equal(daily[0].customer.user.name, walkIn.customerName);
      assert.equal(
        (await changeBooking(created.booking.id, owner, "COMPLETED", walkInStart + 60 * MINUTE)).status,
        "COMPLETED",
      );
    },
  );

  if (external)
    await suite.test(
      "the PostgreSQL exclusion constraint holds across distinct transactional connections",
      async () => {
        const start = Date.parse("2026-12-03T10:00:00+05:30");
        const backends = new Set<number>();
        let unblock = () => {};
        const entered = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const fallback = setTimeout(unblock, 4000);
        fallback.unref();
        try {
          const outcomes = await Promise.allSettled(
            [first.id, second.id].map((customerId) =>
              db.$transaction(
                async (tx) => {
                  const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                  backends.add(connection.pid);
                  if (backends.size === 2) unblock();
                  await entered;
                  return tx.booking.create({
                    data: {
                      customerId,
                      providerId: provider.id,
                      branchId: branch.id,
                      staffId: staff.id,
                      ...reservation(start, 45, 15, 0),
                      timeZone: branch.timeZone,
                      mode: "VENUE",
                      status: "PENDING",
                      totalPaise: 120_000,
                      cancelBeforeHours: 2,
                      requestKey: randomUUID(),
                      requestHash: "native-exclusion-test",
                    },
                  });
                },
                { maxWait: 6000, timeout: 10000 },
              ),
            ),
          );
          assert.equal(backends.size, 2, "The writers must use separate PostgreSQL backend processes");
          assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
          const rejected = outcomes.find((result) => result.status === "rejected");
          assert.ok(rejected && /booking_staff_overlap|23P01|40P01|deadlock/i.test(String(rejected.reason)));
        } finally {
          clearTimeout(fallback);
        }
      },
    );
});
