import { Prisma, type ProviderStatus } from "@prisma/client";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { lockProvider } from "@/lib/provider-lock";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { daySchedule, localDate, OCCUPIED, overlaps } from "@/lib/schedule";
import {
  cancellationPolicySchema,
  email,
  id,
  imageUrl,
  instant,
  latitude,
  longitude,
  password,
  requiredText,
  text,
  timeZone,
  whole,
} from "@/lib/schemas";
import { hashPassword, seal } from "@/lib/secrets";

const profile = z.object({
  action: z.literal("profile"),
  displayName: requiredText(80),
  description: text(1800),
  city: requiredText(80),
  area: requiredText(100),
  image: imageUrl.nullable().optional(),
  gallery: z.array(imageUrl).max(10).optional(),
  specialties: z.array(requiredText(70)).max(15).optional(),
  homeEnabled: z.boolean(),
  travelRadiusKm: whole(1, 100),
  travelBasePaise: whole(0, 100_000),
  travelPerKmPaise: whole(0, 20_000),
  travelMinutesPerKm: whole(1, 25),
  cancelBeforeHours: whole(0, 168),
  autoConfirm: z.boolean(),
  payout: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/, "Enter a valid UPI ID.")
    .optional(),
});
const branch = z
  .object({
    action: z.literal("branch"),
    branchId: id.optional(),
    name: requiredText(70),
    address: requiredText(400),
    timeZone,
    latitude: latitude.nullable(),
    longitude: longitude.nullable(),
  })
  .refine(
    (item) => (item.latitude === null) === (item.longitude === null),
    "Enter both coordinates or leave both blank.",
  );

const staff = z
  .object({
    action: z.literal("staff"),
    staffId: id.optional(),
    branchId: id,
    name: requiredText(80),
    title: text(75),
    commissionBps: whole(0, 10000),
    email: email.optional(),
    password: password.optional(),
  })
  .refine(
    (item) => Boolean(item.email) === Boolean(item.password),
    "Enter both an email and password to create a login.",
  );

const window = z
  .object({
    dayOfWeek: whole(1, 7),
    startMinute: whole(0, 1439),
    endMinute: whole(1, 1440),
    kind: z.enum(["WORK", "BREAK"]),
  })
  .refine((item) => item.endMinute > item.startMinute, "A schedule window must end after it begins.");
const schedule = z.object({ action: z.literal("schedule"), staffId: id, windows: z.array(window).max(42) });
const timeOff = z
  .object({
    action: z.literal("time-off"),
    staffId: id,
    startsAt: instant,
    endsAt: instant,
    reason: text(140),
  })
  .refine(
    (item) => Date.parse(item.endsAt) > Date.parse(item.startsAt),
    "The block must end after it begins.",
  );
const holiday = z.object({
  action: z.literal("add-holiday"),
  branchId: id,
  date: z.iso.date(),
  reason: text(140),
});
const service = z
  .object({
    action: z.literal("service"),
    serviceId: id.optional(),
    categoryId: id,
    name: requiredText(100),
    description: text(750),
    kind: z.enum(["SERVICE", "ADD_ON", "PACKAGE"]).default("SERVICE"),
    duration: whole(5, 480),
    buffer: whole(0, 120),
    pricePaise: whole(0, 5_000_000),
    listPaise: whole(1, 5_000_000).nullable(),
    homeEligible: z.boolean(),
    staffIds: z
      .array(id)
      .min(1)
      .max(100)
      .refine((items) => items.length === new Set(items).size, "Staff must be unique."),
  })
  .refine(
    (item) => item.listPaise === null || item.listPaise > item.pricePaise,
    "The original price must be greater than the booking price.",
  );

export const providerCommand = z.discriminatedUnion("action", [
  profile,
  branch,
  staff,
  schedule,
  cancellationPolicySchema.safeExtend({ action: z.literal("cancellation-policy") }),
  timeOff,
  holiday,
  service,
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("remove-time-off"), blockId: id }),
  z.object({ action: z.literal("remove-holiday"), branchId: id, date: z.iso.date() }),
  z.object({ action: z.literal("archive-staff"), staffId: id }),
  z.object({ action: z.literal("archive-branch"), branchId: id }),
  z.object({ action: z.literal("park-service"), serviceId: id, active: z.boolean() }),
  z.object({ action: z.literal("delete-service"), serviceId: id }),
]);

export const decisionSchema = z
  .object({
    providerId: id,
    status: z.enum(["APPROVED", "REJECTED", "SUSPENDED", "PENDING"]),
    note: text(500).optional(),
  })
  .refine(
    ({ status, note }) => !["REJECTED", "SUSPENDED"].includes(status) || Boolean(note),
    "Add a reason for rejection or suspension.",
  );

const providerFields = {
  id: true,
  displayName: true,
  slug: true,
  city: true,
  area: true,
  type: true,
  status: true,
  description: true,
  image: true,
  gallery: true,
  specialties: true,
  homeEnabled: true,
  travelRadiusKm: true,
  travelBasePaise: true,
  travelPerKmPaise: true,
  travelMinutesPerKm: true,
  cancelBeforeHours: true,
  autoConfirm: true,
  depositBps: true,
  gstRegistered: true,
  gstin: true,
  gstRateBps: true,
  freeRefundHours: true,
  noRefundHours: true,
  cancellationFeeBps: true,
  noShowFeeBps: true,
  reviewNote: true,
} satisfies Prisma.ProviderProfileSelect;

const studioFields = {
  ...providerFields,
  branches: {
    where: { active: true },
    orderBy: { name: "asc" },
    include: { holidays: { orderBy: { date: "asc" } } },
  },
  staff: {
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      windows: { orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] },
      timeOff: { orderBy: { startsAt: "asc" } },
      user: { select: { email: true } },
    },
  },
  services: { orderBy: { name: "asc" }, include: { staff: { select: { staffId: true } }, category: true } },
  documents: {
    orderBy: { createdAt: "desc" },
    select: { id: true, filename: true, contentType: true, createdAt: true },
  },
} as const satisfies Prisma.ProviderProfileSelect;
export type Studio = Prisma.ProviderProfileGetPayload<{ select: typeof studioFields }>;

export async function studioFor(ownerId: string) {
  const provider = await db.providerProfile.findUnique({ where: { ownerId }, select: studioFields });
  if (!provider) throw new HttpError(404, "Studio not found.");
  const payout = await db.providerProfile.count({
    where: { id: provider.id, payoutEncrypted: { not: null } },
  });
  return { ...provider, payoutAdded: payout > 0 };
}

type Tx = Prisma.TransactionClient;
type Command = z.infer<typeof providerCommand>;

function assertEditable(status: ProviderStatus) {
  if (status === "PENDING" || status === "SUSPENDED")
    throw new HttpError(409, "Studio changes are paused while your listing is under review or suspended.");
}

async function findStaff(tx: Tx, providerId: string, id: string) {
  const person = await tx.staff.findFirst({
    where: { id, providerId, active: true },
    include: { branch: true },
  });
  if (!person) throw new HttpError(404, "Team member not found.");
  return person;
}

async function findBranch(tx: Tx, providerId: string, id: string) {
  const location = await tx.branch.findFirst({ where: { id, providerId, active: true } });
  if (!location) throw new HttpError(404, "Branch not found.");
  return location;
}

async function updateStudio(
  tx: Tx,
  provider: { id: string; ownerId: string; type: "SHOP" | "ARTIST"; status: ProviderStatus },
  command: Command,
  credential?: string,
) {
  const { id: providerId } = provider;
  const now = new Date();
  const upcoming = {
    status: { in: [...OCCUPIED] },
    reservedUntil: { gt: now },
  } satisfies Prisma.BookingWhereInput;
  switch (command.action) {
    case "cancellation-policy": {
      const { freeRefundHours, noRefundHours, cancellationFeeBps, noShowFeeBps } = command;
      const previous = await tx.providerProfile.findUniqueOrThrow({
        where: { id: providerId },
        select: providerFields,
      });
      if (
        previous.freeRefundHours === freeRefundHours &&
        previous.noRefundHours === noRefundHours &&
        previous.cancellationFeeBps === cancellationFeeBps &&
        previous.noShowFeeBps === noShowFeeBps
      )
        return previous;
      const updated = await tx.providerProfile.update({
        where: { id: providerId },
        data: { freeRefundHours, noRefundHours, cancellationFeeBps, noShowFeeBps },
        select: providerFields,
      });
      await tx.auditLog.create({
        data: {
          actorId: provider.ownerId,
          targetId: providerId,
          action: "CANCELLATION_POLICY_CHANGED",
          metadata: { freeRefundHours, noRefundHours, cancellationFeeBps, noShowFeeBps },
        },
      });
      return updated;
    }
    case "profile": {
      const {
        payout,
        displayName,
        description,
        city,
        area,
        image,
        gallery,
        specialties,
        homeEnabled,
        travelRadiusKm,
        travelBasePaise,
        travelPerKmPaise,
        travelMinutesPerKm,
        cancelBeforeHours,
        autoConfirm,
      } = command;
      if (payout && provider.status === "APPROVED")
        throw new HttpError(409, "Contact support to update approved payout details.");
      return tx.providerProfile.update({
        where: { id: providerId },
        data: {
          displayName,
          description,
          city,
          area,
          image,
          gallery,
          specialties,
          homeEnabled: provider.type === "ARTIST" || homeEnabled,
          travelRadiusKm,
          travelBasePaise,
          travelPerKmPaise,
          travelMinutesPerKm,
          cancelBeforeHours,
          autoConfirm,
          ...(payout ? { payoutEncrypted: seal(Buffer.from(payout), `payout:${providerId}`) } : {}),
        },
        select: providerFields,
      });
    }
    case "branch": {
      const { branchId, name, address, timeZone, latitude, longitude } = command;
      const details = { name, address, timeZone, latitude, longitude };
      if (branchId) {
        const old = await findBranch(tx, providerId, branchId);
        if (
          old.timeZone !== details.timeZone &&
          (await tx.booking.count({ where: { ...upcoming, branchId } }))
        )
          throw new HttpError(409, "Change the time zone after existing appointments are resolved.");
        return tx.branch.update({ where: { id: branchId }, data: details });
      }
      if (provider.type === "ARTIST" && (await tx.branch.count({ where: { providerId, active: true } })))
        throw new HttpError(400, "Artists use one service-area base.");
      const location = await tx.branch.create({ data: { ...details, providerId } });
      if (provider.type === "ARTIST") {
        const { displayName } = await tx.providerProfile.findUniqueOrThrow({
          where: { id: providerId },
          select: { displayName: true },
        });
        await tx.staff.create({
          data: { providerId, branchId: location.id, name: displayName, title: "Beauty artist" },
        });
      }
      return location;
    }
    case "staff": {
      const { staffId, branchId, name, title, commissionBps, email } = command;
      await findBranch(tx, providerId, branchId);
      if (provider.type === "ARTIST" && (!staffId || credential))
        throw new HttpError(400, "Your artist account already manages your solo calendar.");
      const data = { branchId, name, title, commissionBps };
      if (staffId) {
        const old = await findStaff(tx, providerId, staffId);
        if (old.userId && credential) throw new HttpError(409, "This team member already has a login.");
        if (old.branchId !== branchId && (await tx.booking.count({ where: { ...upcoming, staffId } })))
          throw new HttpError(409, "Move this person after their upcoming appointments.");
        const account =
          email && credential
            ? await tx.user.create({ data: { email, name, passwordHash: credential, role: "STAFF" } })
            : null;
        return tx.staff.update({
          where: { id: staffId },
          data: { ...data, ...(account ? { userId: account.id } : {}) },
        });
      }
      const account =
        email && credential
          ? await tx.user.create({ data: { email, name, passwordHash: credential, role: "STAFF" } })
          : null;
      return tx.staff.create({ data: { ...data, providerId, userId: account?.id } });
    }
    case "archive-branch": {
      await findBranch(tx, providerId, command.branchId);
      if (await tx.staff.count({ where: { branchId: command.branchId, active: true } }))
        throw new HttpError(409, "Move or archive the branch’s active staff first.");
      if (await tx.booking.count({ where: { ...upcoming, branchId: command.branchId } }))
        throw new HttpError(409, "Resolve upcoming appointments first.");
      return tx.branch.update({ where: { id: command.branchId }, data: { active: false } });
    }
    case "archive-staff": {
      const person = await findStaff(tx, providerId, command.staffId);
      if (provider.type === "ARTIST") throw new HttpError(400, "Artists keep one solo calendar.");
      if (await tx.booking.count({ where: { ...upcoming, staffId: person.id } }))
        throw new HttpError(409, "Resolve this person’s upcoming appointments first.");
      if (person.userId)
        await tx.session.updateMany({
          where: { userId: person.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      return tx.staff.update({ where: { id: person.id }, data: { active: false } });
    }
    case "schedule": {
      const person = await findStaff(tx, providerId, command.staffId);
      const bookings = await tx.booking.findMany({
        where: { ...upcoming, staffId: person.id },
        select: { reservedFrom: true, reservedUntil: true },
      });
      const clash = bookings.some((booking) => {
        const interval = { start: +booking.reservedFrom, end: +booking.reservedUntil };
        const { timeZone } = person.branch;
        const day = daySchedule(localDate(interval.start, timeZone), timeZone, command.windows);
        return (
          !day.work.some((work) => work.start <= interval.start && work.end >= interval.end) ||
          day.breaks.some((pause) => overlaps(pause, interval))
        );
      });
      if (clash) throw new HttpError(409, "The new schedule conflicts with an upcoming appointment.");
      await tx.availabilityWindow.deleteMany({ where: { staffId: person.id } });
      await tx.availabilityWindow.createMany({
        data: command.windows.map((window) => ({ ...window, staffId: person.id })),
      });
      return { windows: command.windows };
    }
    case "time-off": {
      const person = await findStaff(tx, providerId, command.staffId);
      const startsAt = new Date(command.startsAt);
      const endsAt = new Date(command.endsAt);
      if (endsAt <= now) throw new HttpError(400, "Choose a block that ends in the future.");
      if (
        await tx.booking.count({
          where: {
            ...upcoming,
            staffId: person.id,
            reservedFrom: { lt: endsAt },
            reservedUntil: { gt: startsAt },
          },
        })
      )
        throw new HttpError(409, "This block overlaps a reserved appointment.");
      return tx.timeOff.create({ data: { staffId: person.id, startsAt, endsAt, reason: command.reason } });
    }
    case "remove-time-off": {
      const deleted = await tx.timeOff.deleteMany({ where: { id: command.blockId, staff: { providerId } } });
      if (!deleted.count) throw new HttpError(404, "Blocked time not found.");
      return { removed: true };
    }
    case "add-holiday": {
      const location = await findBranch(tx, providerId, command.branchId);
      if (command.date < localDate(+now, location.timeZone))
        throw new HttpError(400, "Choose today or a future holiday date.");
      const { start, end } = daySchedule(command.date, location.timeZone, []);
      const reserved = await tx.booking.count({
        where: {
          ...upcoming,
          branchId: location.id,
          reservedFrom: { lt: new Date(end) },
          reservedUntil: { gt: new Date(start) },
        },
      });
      if (reserved) throw new HttpError(409, "This holiday overlaps a reserved appointment.");
      const data = { branchId: location.id, date: command.date, reason: command.reason };
      return tx.branchHoliday.upsert({
        where: { branchId_date: { branchId: data.branchId, date: data.date } },
        update: { reason: data.reason },
        create: data,
      });
    }
    case "remove-holiday": {
      const deleted = await tx.branchHoliday.deleteMany({
        where: { branchId: command.branchId, date: command.date, branch: { providerId } },
      });
      if (!deleted.count) throw new HttpError(404, "Holiday not found.");
      return { removed: true };
    }
    case "service": {
      const {
        serviceId,
        staffIds,
        categoryId,
        name,
        description,
        kind,
        duration,
        buffer,
        pricePaise,
        listPaise,
        homeEligible,
      } = command;
      const details = {
        categoryId,
        name,
        description,
        kind,
        duration,
        buffer,
        pricePaise,
        listPaise,
        homeEligible,
      };
      if (
        (await tx.staff.count({ where: { providerId, id: { in: staffIds }, active: true } })) !==
        staffIds.length
      )
        throw new HttpError(400, "Select active staff from your studio.");
      if (!(await tx.serviceCategory.count({ where: { id: details.categoryId } })))
        throw new HttpError(400, "Select a valid category.");
      const assignments = staffIds.map((staffId) => ({ staffId }));
      if (serviceId) {
        if (!(await tx.service.count({ where: { id: serviceId, providerId } })))
          throw new HttpError(404, "Service not found.");
        return tx.service.update({
          where: { id: serviceId },
          data: { ...details, staff: { deleteMany: {}, create: assignments } },
        });
      }
      return tx.service.create({ data: { ...details, providerId, staff: { create: assignments } } });
    }
    case "park-service": {
      const updated = await tx.service.updateMany({
        where: { id: command.serviceId, providerId },
        data: { active: command.active },
      });
      if (!updated.count) throw new HttpError(404, "Service not found.");
      return { active: command.active };
    }
    case "delete-service": {
      const service = await tx.service.findFirst({
        where: { id: command.serviceId, providerId },
        select: { id: true, _count: { select: { bookingItems: true } } },
      });
      if (!service) throw new HttpError(404, "Service not found.");
      if (service._count.bookingItems) {
        await tx.service.update({ where: { id: service.id }, data: { active: false } });
        return { removed: "archived" };
      }
      await tx.service.delete({ where: { id: service.id } });
      return { removed: "deleted" };
    }
    case "submit": {
      if (!["DRAFT", "REJECTED"].includes(provider.status))
        throw new HttpError(409, "This studio has already been submitted.");
      const studio = await tx.providerProfile.findUniqueOrThrow({
        where: { id: providerId },
        select: {
          city: true,
          area: true,
          description: true,
          payoutEncrypted: true,
          homeEnabled: true,
          branches: { where: { active: true } },
          _count: { select: { documents: true } },
        },
      });
      if (
        !studio.city ||
        !studio.area ||
        !studio.description ||
        !studio.payoutEncrypted ||
        !studio._count.documents
      ) {
        throw new HttpError(400, "Complete the profile and payout details, and add a verification document.");
      }
      if (
        !studio.branches.length ||
        (studio.homeEnabled &&
          !studio.branches.some((item) => item.latitude !== null && item.longitude !== null))
      ) {
        throw new HttpError(
          400,
          "Add an active branch or service-area base with coordinates for home visits.",
        );
      }
      const ready = await tx.service.count({
        where: {
          providerId,
          active: true,
          kind: { not: "ADD_ON" },
          homeEligible: provider.type === "ARTIST" ? true : undefined,
          staff: {
            some: { staff: { active: true, branch: { active: true }, windows: { some: { kind: "WORK" } } } },
          },
        },
      });
      if (!ready) throw new HttpError(400, "Add a service assigned to a team member with working hours.");
      return tx.providerProfile.update({
        where: { id: providerId },
        data: { status: "PENDING", reviewNote: null },
        select: providerFields,
      });
    }
  }
}

export async function executeStudio(user: Viewer, command: Command) {
  const credential =
    command.action === "staff" && command.password ? await hashPassword(command.password) : undefined;
  const { id } = await studioIdentity(user.id);
  return db.$transaction(async (tx) => {
    await lockProvider(tx, id);
    const provider = await tx.providerProfile.findUniqueOrThrow({
      where: { id },
      select: { id: true, ownerId: true, type: true, status: true },
    });
    assertEditable(provider.status);
    const result = await updateStudio(tx, provider, command, credential);
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: `STUDIO_${command.action.replaceAll("-", "_").toUpperCase()}`,
        targetId: id,
      },
    });
    return result;
  });
}

export async function studioIdentity(ownerId: string) {
  const provider = await db.providerProfile.findUnique({
    where: { ownerId },
    select: { id: true, status: true },
  });
  if (!provider) throw new HttpError(404, "Studio not found.");
  return provider;
}

export async function addDocument(
  user: Viewer,
  file: { filename: string; contentType: string; content: Buffer },
) {
  const { id } = await studioIdentity(user.id);
  return db.$transaction(async (tx) => {
    await lockProvider(tx, id);
    const { status } = await tx.providerProfile.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    assertEditable(status);
    if (status === "APPROVED") throw new HttpError(409, "Contact support to update verified documents.");
    if ((await tx.providerDocument.count({ where: { providerId: id } })) >= 5)
      throw new HttpError(409, "The studio already has five verification documents.");
    const document = await tx.providerDocument.create({
      data: { providerId: id, ...file, content: seal(file.content, `document:${id}`) },
      select: { id: true, filename: true, contentType: true },
    });
    await tx.auditLog.create({
      data: { actorId: user.id, targetId: id, action: "STUDIO_DOCUMENT_UPLOADED" },
    });
    return document;
  });
}

export async function reviewProvider(user: Viewer, input: z.infer<typeof decisionSchema>) {
  return db.$transaction(async (tx) => {
    await lockProvider(tx, input.providerId);
    const current = await tx.providerProfile.findUniqueOrThrow({
      where: { id: input.providerId },
      select: { status: true },
    });
    const allowed: Partial<Record<ProviderStatus, ProviderStatus[]>> = {
      PENDING: ["APPROVED", "REJECTED"],
      APPROVED: ["SUSPENDED"],
      SUSPENDED: ["PENDING"],
    };
    if (!allowed[current.status]?.includes(input.status))
      throw new HttpError(409, "This decision is unavailable for the current application.");
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        targetId: input.providerId,
        action: "PROVIDER_REVIEW",
        metadata: { from: current.status, to: input.status, note: input.note ?? null },
      },
    });
    return tx.providerProfile.update({
      where: { id: input.providerId },
      data: { status: input.status, reviewNote: input.note ?? null },
      select: providerFields,
    });
  });
}

export async function adminOverview() {
  const [customers, providers, bookings, value, applications] = await Promise.all([
    db.user.count({ where: { role: "CUSTOMER" } }),
    db.providerProfile.count(),
    db.booking.count(),
    db.booking.aggregate({ where: { status: "COMPLETED" }, _sum: { totalPaise: true } }),
    db.providerProfile.findMany({
      where: { status: { not: "DRAFT" } },
      take: 150,
      orderBy: { createdAt: "desc" },
      select: {
        ...providerFields,
        owner: { select: { name: true, email: true } },
        documents: { select: { id: true, filename: true } },
      },
    }),
  ]);
  return { customers, providers, bookings, completedValue: value._sum.totalPaise ?? 0, applications };
}
