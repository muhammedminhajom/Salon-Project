import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";

export const categories = [
  ["hair", "Hair"],
  ["skin", "Skin"],
  ["makeup", "Makeup"],
  ["nails", "Nails"],
  ["spa", "Spa"],
  ["bridal", "Bridal"],
  ["mehendi", "Mehendi"],
  ["mens-grooming", "Men’s grooming"],
] as const;

const publicFields = {
  id: true,
  slug: true,
  displayName: true,
  description: true,
  type: true,
  city: true,
  area: true,
  image: true,
  gallery: true,
  specialties: true,
  featured: true,
  rating: true,
  reviewCount: true,
  homeEnabled: true,
} satisfies Prisma.ProviderProfileSelect;

const cardFields = {
  ...publicFields,
  services: {
    where: { active: true },
    select: { pricePaise: true, listPaise: true, categoryId: true, kind: true },
  },
} satisfies Prisma.ProviderProfileSelect;
export type Listing = Prisma.ProviderProfileGetPayload<{ select: typeof cardFields }>;

export const filtersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(80).optional(),
  category: z.string().max(50).optional(),
  type: z.enum(["SHOP", "ARTIST"]).optional(),
  mode: z.enum(["home", "venue"]).optional(),
  sort: z.enum(["recommended", "rating", "price"]).optional(),
  offers: z.enum(["1"]).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  maxPrice: z.coerce.number().int().min(0).max(50_000).optional(),
});

export function urlFilters(query: URLSearchParams | Record<string, string | string[] | undefined>) {
  const get = (key: string) => (query instanceof URLSearchParams ? query.get(key) : query[key]);
  return Object.fromEntries(
    Object.keys(filtersSchema.shape).map((key) => {
      const value = get(key);
      return [key, typeof value === "string" && value ? value : undefined];
    }),
  );
}

export async function discover(filters: z.infer<typeof filtersSchema> = {}) {
  if (filters.mode === "venue" && filters.type === "ARTIST") return [];
  const price = filters.maxPrice === undefined ? undefined : { lte: filters.maxPrice * 100 };
  const matching: Prisma.ServiceWhereInput = {
    active: true,
    kind: { not: "ADD_ON" },
    categoryId: filters.category,
    pricePaise: price,
    listPaise: filters.offers ? { not: null } : undefined,
    homeEligible: filters.mode === "home" ? true : undefined,
    staff: { some: { staff: { active: true, branch: { active: true } } } },
  };
  const listings = await db.providerProfile.findMany({
    where: {
      status: "APPROVED",
      type: filters.type ?? (filters.mode === "venue" ? "SHOP" : undefined),
      homeEnabled: filters.mode === "home" ? true : undefined,
      rating: filters.rating === undefined ? undefined : { gte: filters.rating },
      branches: { some: { active: true } },
      services: { some: matching },
      AND: [
        ...(filters.city
          ? [
              {
                OR: [
                  { city: { contains: filters.city, mode: "insensitive" as const } },
                  { area: { contains: filters.city, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
        ...(filters.q
          ? [
              {
                OR: [
                  { displayName: { contains: filters.q, mode: "insensitive" as const } },
                  { description: { contains: filters.q, mode: "insensitive" as const } },
                  {
                    services: {
                      some: { ...matching, name: { contains: filters.q, mode: "insensitive" as const } },
                    },
                  },
                  {
                    services: {
                      some: {
                        ...matching,
                        category: { name: { contains: filters.q, mode: "insensitive" as const } },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    },
    select: { ...cardFields, services: { ...cardFields.services, where: matching } },
    orderBy: [
      { featured: "desc" },
      { rating: { sort: "desc", nulls: "last" } },
      { reviewCount: "desc" },
      { displayName: "asc" },
    ],
    take: 100,
  });
  if (filters.sort === "price") listings.sort((a, b) => minPrice(a) - minPrice(b));
  if (filters.sort === "rating")
    listings.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount);
  return listings;
}

export function minPrice(listing: Listing) {
  return Math.min(...listing.services.map((service) => service.pricePaise));
}

export function publicProfile(slug: string) {
  return db.providerProfile.findFirst({
    where: { slug, status: "APPROVED" },
    select: {
      ...publicFields,
      cancelBeforeHours: true,
      freeRefundHours: true,
      noRefundHours: true,
      autoConfirm: true,
      travelRadiusKm: true,
      branches: {
        where: { active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, timeZone: true },
      },
      staff: {
        where: { active: true, branch: { active: true } },
        select: {
          id: true,
          name: true,
          title: true,
          branchId: true,
          rating: true,
          reviewCount: true,
          windows: {
            where: { kind: "WORK" },
            select: { id: true, dayOfWeek: true, startMinute: true, endMinute: true },
          },
        },
        orderBy: { name: "asc" },
      },
      services: {
        where: { active: true, staff: { some: { staff: { active: true, branch: { active: true } } } } },
        include: { category: true, staff: { select: { staffId: true } } },
        orderBy: [{ kind: "asc" }, { pricePaise: "asc" }],
      },
    },
  });
}

export type MarketProfile = NonNullable<Awaited<ReturnType<typeof publicProfile>>>;
