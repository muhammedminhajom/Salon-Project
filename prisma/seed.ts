import { Prisma, type ProviderType, type ServiceKind } from "@prisma/client";
import { db } from "../src/lib/db";
import { categories } from "../src/lib/catalog";
import { localDemoAllowed } from "../src/lib/local-demo";
import { hashPassword } from "../src/lib/secrets";
import { recordBookingCompletion } from "../src/lib/finance-ledger";
import { issueBookingInvoices } from "../src/lib/invoices";
import { completePhaseTwoRewards } from "../src/lib/rewards";

const demoPassword = "DemoBeauty2026!";

type DemoService = {
  id: string;
  name: string;
  category: string;
  price: number;
  duration: number;
  description: string;
  original?: number;
  buffer?: number;
  home?: boolean;
  kind?: ServiceKind;
};
type DemoProvider = {
  slug: string;
  type: ProviderType;
  displayName: string;
  description: string;
  area: string;
  image: string;
  rating: number;
  reviews: number;
  specialties: string[];
  address: string;
  lat: number;
  lon: number;
  staff: { name: string; title: string }[];
  services: DemoService[];
  home?: boolean;
  manual?: boolean;
  email: string;
};

const providers: DemoProvider[] = [
  {
    slug: "rosewood-studio",
    type: "SHOP",
    displayName: "Rosewood Studio",
    area: "Panampilly Nagar",
    image: "/images/rosewood.webp",
    description:
      "A neighbourhood hair and skin studio in Panampilly Nagar. Come for a considered consultation, a cut that grows out beautifully, or a quiet hour of skin care.",
    rating: 4.9,
    reviews: 128,
    specialties: ["Hair styling", "Skin treatments"],
    address: "Panampilly Avenue, Panampilly Nagar, Kochi",
    lat: 9.9574,
    lon: 76.2982,
    staff: [
      { name: "Mia Mathew", title: "Senior stylist" },
      { name: "Nisha Varghese", title: "Stylist and skin therapist" },
    ],
    email: "studio@bloomblush.test",
    services: [
      {
        id: "signature-haircut",
        category: "hair",
        name: "Signature haircut",
        price: 799,
        original: 1099,
        duration: 45,
        buffer: 15,
        description: "Style consultation, precision cut, and a finished blow-dry.",
      },
      {
        id: "glow-facial",
        category: "skin",
        name: "Botanical glow facial",
        price: 1299,
        duration: 60,
        buffer: 15,
        description: "A soothing facial with a hydrating botanical mask.",
      },
      {
        id: "scalp-massage",
        category: "spa",
        name: "Scalp massage",
        price: 349,
        duration: 15,
        kind: "ADD_ON",
        description: "Relaxing warm oil scalp treatment.",
      },
      {
        id: "beard-and-cut",
        category: "mens-grooming",
        name: "Haircut and beard trim",
        price: 899,
        duration: 50,
        buffer: 10,
        description: "A tailored cut with a beard trim and finish.",
      },
    ],
  },
  {
    slug: "ananya-artistry",
    type: "ARTIST",
    displayName: "Ananya Artistry",
    area: "Fort Kochi",
    image: "/images/ananya.webp",
    description:
      "Ananya brings her makeup kit to you across central Kochi. Her style favours fresh skin, soft colour, and detailed finishes for events, engagements, and weddings.",
    rating: 4.9,
    reviews: 96,
    specialties: ["Bridal", "Makeup", "Mehendi"],
    address: "Fort Kochi service area",
    lat: 9.9649,
    lon: 76.2426,
    staff: [{ name: "Ananya Menon", title: "Makeup artist" }],
    home: true,
    manual: true,
    email: "artist@bloomblush.test",
    services: [
      {
        id: "occasion-makeup",
        category: "makeup",
        name: "Soft glam makeup",
        price: 1499,
        duration: 60,
        buffer: 15,
        home: true,
        description: "A light, long-wear look for your next occasion.",
      },
      {
        id: "bridal-preview",
        category: "bridal",
        name: "Bridal makeup and hair preview",
        price: 2499,
        duration: 90,
        buffer: 15,
        kind: "PACKAGE",
        home: true,
        description: "Plan and try your wedding-day look together.",
      },
      {
        id: "occasion-mehendi",
        category: "mehendi",
        name: "Occasion mehendi",
        price: 1499,
        duration: 70,
        buffer: 10,
        home: true,
        description: "Detailed mehendi for both hands.",
      },
    ],
  },
  {
    slug: "petal-nail-bar",
    type: "SHOP",
    displayName: "Petal Nail Bar",
    area: "Edappally",
    image: "/images/petal.webp",
    description:
      "A boutique nail bar with a soft spot for thoughtful nail art and fuss-free manicures. Visit our Edappally studio or book selected services at home.",
    rating: 4.8,
    reviews: 84,
    specialties: ["Manicures", "Nail art"],
    address: "Edappally Junction, Kochi",
    lat: 10.0261,
    lon: 76.3088,
    staff: [{ name: "Diya Joseph", title: "Nail technician" }],
    home: true,
    email: "nails@bloomblush.test",
    services: [
      {
        id: "express-manicure",
        category: "nails",
        name: "Express manicure",
        price: 599,
        duration: 30,
        buffer: 10,
        description: "Nail shaping, cuticle care, and a timeless polish.",
        home: true,
      },
      {
        id: "gel-nails",
        category: "nails",
        name: "Gel manicure",
        price: 1099,
        original: 1399,
        duration: 55,
        buffer: 10,
        description: "Classic manicure with a long-wearing gel finish.",
        home: true,
      },
      {
        id: "spa-pedicure",
        category: "spa",
        name: "Spa pedicure",
        price: 1199,
        duration: 60,
        buffer: 10,
        description: "Soak, exfoliation, foot massage, and polish.",
      },
    ],
  },
];

async function seedDemoProvider(spec: DemoProvider, passwordHash: string) {
  if (await db.providerProfile.count({ where: { slug: spec.slug } })) return;
  await db.$transaction(async (tx) => {
    const provider = await tx.providerProfile.create({
      data: {
        id: spec.slug,
        slug: spec.slug,
        type: spec.type,
        status: "APPROVED",
        displayName: spec.displayName,
        description: spec.description,
        area: spec.area,
        city: "Kochi",
        image: spec.image,
        gallery: [],
        featured: true,
        rating: spec.rating,
        reviewCount: spec.reviews,
        specialties: spec.specialties,
        autoConfirm: !spec.manual,
        depositBps: 2500,
        freeRefundHours: 24,
        noRefundHours: 2,
        cancellationFeeBps: 2500,
        noShowFeeBps: 10000,
        homeEnabled: spec.home ?? false,
        travelRadiusKm: 18,
        travelBasePaise: 12_000,
        travelPerKmPaise: 1_500,
        owner: { create: { email: spec.email, role: "PROVIDER", name: spec.displayName, passwordHash } },
      },
    });
    const location = await tx.branch.create({
      data: {
        id: `${spec.slug}-main`,
        providerId: provider.id,
        name: spec.type === "ARTIST" ? "Fort Kochi service area" : `${spec.area} studio`,
        address: spec.address,
        latitude: spec.lat,
        longitude: spec.lon,
        timeZone: "Asia/Kolkata",
      },
    });
    const team = await Promise.all(
      spec.staff.map((person, index) => {
        const windows: Prisma.AvailabilityWindowCreateWithoutStaffInput[] = [1, 2, 3, 4, 5, 6, 7].flatMap(
          (dayOfWeek) => [
            { dayOfWeek, startMinute: 600, endMinute: 1140, kind: "WORK" },
            { dayOfWeek, startMinute: 780, endMinute: 840, kind: "BREAK" },
          ],
        );
        return tx.staff.create({
          data: {
            ...person,
            id: `${spec.slug}-staff-${index + 1}`,
            provider: { connect: { id: provider.id } },
            branch: { connect: { id: location.id } },
            windows: { create: windows },
            ...(spec.slug === "rosewood-studio" && index === 0
              ? {
                  user: {
                    create: {
                      name: person.name,
                      role: "STAFF" as const,
                      email: "staff@bloomblush.test",
                      passwordHash,
                    },
                  },
                }
              : {}),
          },
        });
      }),
    );
    for (const service of spec.services) {
      await tx.service.create({
        data: {
          id: service.id,
          providerId: provider.id,
          name: service.name,
          categoryId: service.category,
          description: service.description,
          pricePaise: service.price * 100,
          listPaise: service.original ? service.original * 100 : undefined,
          duration: service.duration,
          buffer: service.buffer,
          kind: service.kind,
          homeEligible: service.home ?? false,
          staff: { create: team.map(({ id }) => ({ staffId: id })) },
        },
      });
    }
  });
}

async function seedPhaseTwoDemo() {
  const [customer, admin, provider, service, staff, branch] = await Promise.all([
    db.user.findUnique({ where: { email: "customer@bloomblush.test" } }),
    db.user.findUnique({ where: { email: "admin@bloomblush.test" } }),
    db.providerProfile.findUnique({ where: { slug: "rosewood-studio" } }),
    db.service.findUnique({ where: { id: "signature-haircut" } }),
    db.staff.findFirst({ where: { providerId: "rosewood-studio" }, orderBy: { id: "asc" } }),
    db.branch.findUnique({ where: { id: "rosewood-studio-main" } }),
  ]);
  if (!customer || !admin || !provider || !service || !staff || !branch) return;

  await db.referralCode.upsert({
    where: { userId: customer.id },
    update: {},
    create: { userId: customer.id, code: "MEERA-FRIEND" },
  });
  const now = new Date();
  const validFrom = new Date(now.getTime() - 86_400_000);
  const validUntil = new Date(now.getTime() + 365 * 86_400_000);
  await db.coupon.upsert({
    where: { code: "WELCOME10" },
    update: {},
    create: {
      code: "WELCOME10",
      kind: "FIRST_BOOKING",
      discountType: "PERCENT",
      funding: "PLATFORM",
      createdById: admin.id,
      amount: 1000,
      maxDiscountPaise: 10000,
      minCartPaise: 0,
      totalUses: 1000,
      perUserLimit: 1,
      validFrom,
      validUntil,
    },
  });
  await db.coupon.upsert({
    where: { code: "ROSEWOOD10" },
    update: {},
    create: {
      code: "ROSEWOOD10",
      kind: "PROVIDER",
      discountType: "PERCENT",
      funding: "PROVIDER",
      providerId: provider.id,
      createdById: provider.ownerId,
      amount: 1000,
      maxDiscountPaise: 10000,
      minCartPaise: 0,
      totalUses: 1000,
      perUserLimit: 1,
      validFrom,
      validUntil,
    },
  });

  const requestKey = "demo-phase-two-completed";
  const existingBooking = await db.booking.findUnique({
    where: { customerId_requestKey: { customerId: customer.id, requestKey } },
  });
  if (!existingBooking) {
    const startsAt = new Date(now.getTime() - 5 * 86_400_000);
    startsAt.setUTCHours(5, 30, 0, 0);
    if (startsAt > now) startsAt.setUTCDate(startsAt.getUTCDate() - 1);
    const endsAt = new Date(startsAt.getTime() + service.duration * 60_000);
    const reservedUntil = new Date(endsAt.getTime() + service.buffer * 60_000);
    await db.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          customerId: customer.id,
          providerId: provider.id,
          branchId: branch.id,
          staffId: staff.id,
          mode: "VENUE",
          status: "COMPLETED",
          startsAt,
          endsAt,
          reservedFrom: startsAt,
          reservedUntil,
          timeZone: branch.timeZone,
          totalPaise: service.pricePaise,
          cancelBeforeHours: provider.cancelBeforeHours,
          freeRefundHours: provider.freeRefundHours,
          noRefundHours: provider.noRefundHours,
          cancellationFeeBps: provider.cancellationFeeBps,
          noShowFeeBps: provider.noShowFeeBps,
          paymentMode: "PAY_AT_VENUE",
          requestKey,
          requestHash: requestKey,
          items: {
            create: {
              serviceId: service.id,
              name: service.name,
              duration: service.duration,
              buffer: service.buffer,
              pricePaise: service.pricePaise,
              commissionBps: 1000,
              position: 0,
            },
          },
          payment: {
            create: {
              gatewayAmountPaise: 0,
              walletUsedPaise: 0,
              dueAtVenuePaise: service.pricePaise,
            },
          },
        },
      });
      await recordBookingCompletion(tx, created.id);
      await completePhaseTwoRewards(tx, created.id, customer.id, now);
      await issueBookingInvoices(tx, created.id, now);
      await tx.review.create({
        data: {
          bookingId: created.id,
          customerId: customer.id,
          providerId: provider.id,
          staffId: staff.id,
          rating: 5,
          body: "A thoughtful consultation and a lovely finish.",
          editUntil: new Date(now.getTime() + 2 * 86_400_000),
          createdAt: now,
        },
      });
      await Promise.all([
        tx.providerProfile.update({
          where: { id: provider.id },
          data: { rating: 5, reviewCount: 1 },
        }),
        tx.staff.update({ where: { id: staff.id }, data: { rating: 5, reviewCount: 1 } }),
      ]);
      return created;
    });
  }
}

async function main() {
  for (const [position, [id, name]] of categories.entries()) {
    await db.serviceCategory.upsert({
      where: { id },
      update: { name, position },
      create: { id, name, position },
    });
  }
  await db.financeSetting.upsert({
    where: { id: "platform" },
    update: {},
    create: { id: "platform" },
  });
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail || adminPassword) {
    if (!adminEmail || !adminPassword || adminPassword.length < 14)
      throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 14 characters.");
    const admin = await db.user.upsert({
      where: { email: adminEmail },
      update: {},
      create: {
        email: adminEmail,
        name: "Marketplace Admin",
        role: "ADMIN",
        passwordHash: await hashPassword(adminPassword),
      },
    });
    if (admin.role !== "ADMIN") throw new Error("ADMIN_EMAIL is already used by another role.");
  }
  if (process.env.DEMO_SEED !== "true") {
    console.log("Catalog categories and any configured administrator are ready.");
    return;
  }
  if (
    !localDemoAllowed() ||
    !/^postgres(?:ql)?:\/\/[^/]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(process.env.DATABASE_URL ?? "")
  ) {
    throw new Error("Demo accounts require a local app URL, a loopback database, and non-production mode.");
  }
  const passwordHash = await hashPassword(demoPassword);
  const sampleAccounts = [
    { email: "customer@bloomblush.test", name: "Meera Joseph", role: "CUSTOMER" as const },
    { email: "admin@bloomblush.test", name: "Demo Admin", role: "ADMIN" as const },
  ];
  for (const account of sampleAccounts) {
    await db.user.upsert({
      where: { email: account.email },
      update: {},
      create: {
        ...account,
        passwordHash,
        ...(account.role === "CUSTOMER" ? { customer: { create: {} } } : {}),
      },
    });
  }
  for (const provider of providers) await seedDemoProvider(provider, passwordHash);
  await seedPhaseTwoDemo();
  console.log("Demo marketplace accounts and listings are ready.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
