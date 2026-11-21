import { InvoiceKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { portion } from "@/lib/money";

type Tx = Prisma.TransactionClient;

function financialYear(date: Date) {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

async function nextInvoiceNumber(tx: Tx, date: Date) {
  const year = financialYear(date);
  const [row] = await tx.$queryRaw<{ sequence: number }[]>`
    INSERT INTO "InvoiceCounter" ("financialYear", "nextSequence") VALUES (${year}, 2)
    ON CONFLICT ("financialYear") DO UPDATE
      SET "nextSequence" = "InvoiceCounter"."nextSequence" + 1
    RETURNING "nextSequence" - 1 AS sequence
  `;
  return {
    year,
    sequence: row.sequence,
    invoiceNumber: `BB/${year}/${String(row.sequence).padStart(6, "0")}`,
  };
}

async function issue(
  tx: Tx,
  bookingId: string,
  kind: InvoiceKind,
  snapshot: Prisma.InputJsonValue,
  issuedAt: Date,
  parentInvoiceId?: string,
) {
  const existing = await tx.invoice.findFirst({
    where: { bookingId, kind, parentInvoiceId: parentInvoiceId ?? null },
  });
  if (existing) return existing;
  const number = await nextInvoiceNumber(tx, issuedAt);
  return tx.invoice.create({
    data: {
      bookingId,
      kind,
      financialYear: number.year,
      sequence: number.sequence,
      invoiceNumber: number.invoiceNumber,
      parentInvoiceId,
      snapshot,
      issuedAt,
    },
  });
}

export async function issueBookingInvoices(tx: Tx, bookingId: string, issuedAt = new Date()) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      items: { orderBy: { position: "asc" } },
      provider: { include: { owner: { select: { name: true, email: true } } } },
      customer: { include: { user: { select: { name: true, email: true } } } },
      branch: { select: { name: true, address: true } },
    },
  });
  if (!booking || booking.status !== "COMPLETED") return [];
  const subtotalPaise = booking.items.reduce((sum, item) => sum + item.pricePaise, booking.travelPaise);
  const commissionPaise = booking.items.reduce(
    (sum, item) => sum + portion(item.pricePaise, item.commissionBps),
    0,
  );
  const issued = issuedAt.toISOString();
  const common = {
    issuedAt: issued,
    currency: booking.currency,
    bookingId: booking.id,
    paymentMode: booking.paymentMode,
    provider: {
      name: booking.provider.displayName,
      owner: booking.provider.owner.name,
      address: [booking.provider.area, booking.provider.city].filter(Boolean).join(", "),
      gstin: booking.supplierGstin,
    },
    customer: { name: booking.customer.user.name, email: booking.customer.user.email },
    appointmentAt: booking.startsAt.toISOString(),
    branch: booking.branch,
    items: booking.items.map((item) => ({
      name: item.name,
      quantity: 1,
      unitPricePaise: item.pricePaise,
      commissionBps: item.commissionBps,
    })),
    travelPaise: booking.travelPaise,
    subtotalPaise,
    discountPaise: booking.discountPaise,
    taxablePaise: Math.max(0, subtotalPaise - booking.discountPaise),
    taxRateBps: booking.taxRateBps,
    taxPaise: booking.taxPaise,
    totalPaise: booking.totalPaise,
  };
  const customer = await issue(
    tx,
    booking.id,
    "CUSTOMER",
    { ...common, invoiceType: "CUSTOMER_TAX_INVOICE" },
    issuedAt,
  );
  const commission = await issue(
    tx,
    booking.id,
    "PLATFORM_COMMISSION",
    {
      invoiceType: "PLATFORM_COMMISSION_INVOICE",
      issuedAt: issued,
      currency: booking.currency,
      bookingId: booking.id,
      provider: { name: booking.provider.displayName, email: booking.provider.owner.email },
      platform: { name: "Bloom & Blush" },
      items: [{ name: "Platform commission", amountPaise: commissionPaise }],
      subtotalPaise: commissionPaise,
      taxPaise: 0,
      totalPaise: commissionPaise,
    },
    issuedAt,
  );
  return [customer, commission];
}

export async function issueCreditNotes(
  tx: Tx,
  bookingId: string,
  refundId: string,
  amountPaise: number,
  commissionPaise: number,
  issuedAt = new Date(),
) {
  const parents = await tx.invoice.findMany({
    where: { bookingId, kind: { in: ["CUSTOMER", "PLATFORM_COMMISSION"] }, parentInvoiceId: null },
  });
  const notes = [];
  for (const parent of parents) {
    const creditedPaise = parent.kind === "CUSTOMER" ? amountPaise : commissionPaise;
    if (!creditedPaise) continue;
    notes.push(
      await issue(
        tx,
        bookingId,
        "CREDIT_NOTE",
        {
          invoiceType: "CREDIT_NOTE",
          issuedAt: issuedAt.toISOString(),
          currency: "INR",
          originalInvoiceNumber: parent.invoiceNumber,
          refundId,
          creditedPaise,
          totalPaise: -creditedPaise,
        },
        issuedAt,
        parent.id,
      ),
    );
  }
  return notes;
}

function ascii(input: string) {
  return input
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .slice(0, 150);
}

export function renderInvoicePdf(input: {
  invoiceNumber: string;
  kind: InvoiceKind;
  snapshot: Prisma.JsonValue;
}) {
  const snapshot = input.snapshot as Record<string, unknown>;
  const customer = snapshot.customer as Record<string, unknown> | undefined;
  const provider = (snapshot.provider ?? snapshot.platform) as Record<string, unknown> | undefined;
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const lines = [
    "BLOOM & BLUSH",
    input.kind === "CREDIT_NOTE"
      ? "CREDIT NOTE"
      : input.kind === "PLATFORM_COMMISSION"
        ? "PLATFORM COMMISSION INVOICE"
        : "TAX INVOICE",
    `Invoice: ${input.invoiceNumber}`,
    `Issued: ${String(snapshot.issuedAt ?? "")}`,
    `Provider: ${String(provider?.name ?? "")}`,
    `Customer: ${String(customer?.name ?? provider?.email ?? "")}`,
    `Appointment: ${String(snapshot.appointmentAt ?? snapshot.bookingId ?? "")}`,
    `Payment mode: ${String(snapshot.paymentMode ?? "")}`,
    "Items:",
    ...items.map((item) => {
      const row = item as Record<string, unknown>;
      const paise = Number(row.unitPricePaise ?? row.amountPaise ?? 0);
      return `  ${String(row.name ?? "Item")} - INR ${(paise / 100).toFixed(2)}`;
    }),
    `Subtotal (paise): ${String(snapshot.subtotalPaise ?? "")}`,
    `Discount (paise): ${String(snapshot.discountPaise ?? "0")}`,
    `GST (paise): ${String(snapshot.taxPaise ?? "0")}`,
    `Total (paise): ${String(snapshot.totalPaise ?? snapshot.creditedPaise ?? "")}`,
    `Currency: ${String(snapshot.currency ?? "INR")}`,
  ].map(ascii);
  const content = `BT /F1 10 Tf 48 790 Td 14 TL ${lines.map((line, index) => `${index ? "T* " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

export async function getInvoice(id: string) {
  return db.invoice.findUnique({
    where: { id },
    include: { booking: { include: { provider: { select: { ownerId: true } } } } },
  });
}
