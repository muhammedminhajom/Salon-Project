import { LedgerAccount, Prisma, type PayoutRequest } from "@prisma/client";
import type { z } from "zod";
import { db } from "@/lib/db";
import { lockFinanceProvider, postLedgerBatch } from "@/lib/finance-ledger";
import { enqueueEvent } from "@/lib/notifications";
import { HttpError } from "@/lib/http";
import { currency } from "@/lib/money";
import { seal, unseal } from "@/lib/secrets";
import {
  commissionOverrideSchema,
  commissionSettingsSchema,
  payoutActionSchema,
  payoutDetailsSchema,
  payoutRequestSchema,
} from "@/lib/schemas";

type Tx = Prisma.TransactionClient;
type PayoutInput = z.infer<typeof payoutRequestSchema>;
type PayoutAction = z.infer<typeof payoutActionSchema>;
type PayoutDetails = z.infer<typeof payoutDetailsSchema>;
type FinanceFilter = { from?: Date; until?: Date; staffId?: string };
type ProviderFinanceData = {
  balance: Awaited<ReturnType<typeof groupedBalance>>;
  currency: typeof currency;
  ledger: Prisma.LedgerEntryGetPayload<{
    include: { booking: { select: { startsAt: true } }; staff: { select: { name: true } } };
  }>[];
  payouts: Prisma.PayoutRequestGetPayload<{
    select: {
      id: true;
      amountPaise: true;
      currency: true;
      status: true;
      reference: true;
      createdAt: true;
      eligibleAt: true;
    };
  }>[];
  payoutDetailsAdded: boolean;
};

export function maskPayoutDetails(details?: PayoutDetails | null) {
  if (!details) return null;
  return details.type === "UPI"
    ? { type: details.type, upiId: details.upiId.replace(/^(.{1,2})[^@]+/, "$1••••") }
    : {
        type: details.type,
        accountHolderName: details.accountHolderName,
        accountNumber: "••••" + details.accountNumber.slice(-4),
        ifsc: "••••••••••" + details.ifsc.slice(-2),
      };
}

async function groupedBalance(tx: Tx, providerId: string) {
  const [balances, active] = await Promise.all([
    tx.ledgerEntry.groupBy({
      by: ["account"],
      where: { providerId },
      _sum: { amountPaise: true },
    }),
    tx.payoutRequest.aggregate({
      where: { providerId, status: { in: ["PENDING", "APPROVED"] } },
      _sum: { amountPaise: true },
    }),
  ]);
  const amount = (account: LedgerAccount) =>
    balances.find((entry) => entry.account === account)?._sum.amountPaise ?? 0;
  const providerNetPaise = -amount("PROVIDER_PAYABLE");
  const taxPayablePaise = -amount("TAX_PAYABLE");
  const payablePaise = providerNetPaise + taxPayablePaise;
  const duesPaise = amount("PROVIDER_DUES");
  const reservedPaise = active._sum.amountPaise ?? 0;
  return {
    payablePaise,
    providerNetPaise,
    taxPayablePaise,
    duesPaise,
    reservedPaise,
    availablePaise: Math.max(0, payablePaise - duesPaise - reservedPaise),
  };
}

function csv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const safe = /^[=+@-]/.test(cell) ? "'" + cell : cell;
          return '"' + safe.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}

export function getProviderFinance(
  providerId: string,
  input: FinanceFilter & { asCsv: true },
): Promise<string>;
export function getProviderFinance(
  providerId: string,
  input: FinanceFilter & { asCsv: boolean },
): Promise<ProviderFinanceData | string>;
export function getProviderFinance(
  providerId: string,
  input?: FinanceFilter & { asCsv?: false },
): Promise<ProviderFinanceData>;
export async function getProviderFinance(
  providerId: string,
  input: FinanceFilter & { asCsv?: boolean } = {},
): Promise<ProviderFinanceData | string> {
  if (input.staffId) {
    const staff = await db.staff.findFirst({
      where: { id: input.staffId, providerId },
      select: { id: true },
    });
    if (!staff) throw new HttpError(404, "This staff member was not found.");
  }
  const where = {
    providerId,
    ...(input.from || input.until ? { createdAt: { gte: input.from, lt: input.until } } : {}),
    ...(input.staffId ? { staffId: input.staffId } : {}),
  };
  const [ledger, balance, payouts, details] = await Promise.all([
    db.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 5000,
      include: { booking: { select: { startsAt: true } }, staff: { select: { name: true } } },
    }),
    db.$transaction((tx) => groupedBalance(tx, providerId)),
    db.payoutRequest.findMany({
      where: { providerId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        amountPaise: true,
        currency: true,
        status: true,
        reference: true,
        createdAt: true,
        eligibleAt: true,
      },
    }),
    db.providerProfile.findUnique({
      where: { id: providerId },
      select: { payoutDetailsEncrypted: true },
    }),
  ]);
  if (input.asCsv) {
    return csv([
      ["Date", "Appointment date", "Staff", "Account", "Amount (paise)", "Currency"],
      ...ledger.map((entry) => [
        entry.createdAt.toISOString(),
        entry.booking?.startsAt.toISOString() ?? "",
        entry.staff?.name ?? "",
        entry.account,
        String(entry.amountPaise),
        entry.currency,
      ]),
    ]);
  }
  return {
    balance,
    currency,
    ledger,
    payouts,
    payoutDetailsAdded: Boolean(details?.payoutDetailsEncrypted),
  };
}

export async function requestPayout(
  providerId: string,
  input: PayoutInput,
  actorId: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    await lockFinanceProvider(tx, providerId);
    const previous = await tx.payoutRequest.findUnique({
      where: { providerId_requestKey: { providerId, requestKey: input.requestKey } },
    });
    if (previous) {
      if (previous.amountPaise !== input.amountPaise)
        throw new HttpError(409, "This payout key was already used for another amount.");
      return previous;
    }
    const profile = await tx.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
      select: { status: true, payoutDetailsEncrypted: true },
    });
    if (profile.status !== "APPROVED")
      throw new HttpError(409, "Only approved providers can request payouts.");
    if (!profile.payoutDetailsEncrypted)
      throw new HttpError(409, "Add payout details before requesting a payout.");
    const settings = await tx.financeSetting.findUniqueOrThrow({ where: { id: "platform" } });
    if (input.amountPaise < settings.minimumPayoutPaise)
      throw new HttpError(400, "The payout is below the minimum payout amount.");
    const balance = await groupedBalance(tx, providerId);
    if (input.amountPaise > balance.availablePaise)
      throw new HttpError(409, "The requested payout exceeds the available balance.");
    const payout = await tx.payoutRequest.create({
      data: {
        providerId,
        requestKey: input.requestKey,
        amountPaise: input.amountPaise,
        createdAt: now,
        eligibleAt: new Date(now.getTime() + settings.payoutCycleDays * 24 * 60 * 60 * 1000),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: providerId,
        action: "PAYOUT_REQUESTED",
        metadata: { payoutId: payout.id, amountPaise: payout.amountPaise, currency },
      },
    });
    return payout;
  });
}

export async function savePayoutDetails(providerId: string, details: PayoutDetails, actorId: string) {
  const encrypted = seal(Buffer.from(JSON.stringify(details)), "payout-details:" + providerId);
  return db.$transaction(async (tx) => {
    await lockFinanceProvider(tx, providerId);
    const profile = await tx.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
      select: { status: true },
    });
    if (profile.status === "PENDING" || profile.status === "SUSPENDED")
      throw new HttpError(409, "Payout details cannot be changed during review or suspension.");
    await tx.providerProfile.update({
      where: { id: providerId },
      data: { payoutDetailsEncrypted: encrypted },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: providerId,
        action: "PAYOUT_DETAILS_CHANGED",
        metadata: { type: details.type },
      },
    });
    return { added: true, details: maskPayoutDetails(details) };
  });
}

export async function getAdminPayouts() {
  const payouts = await db.payoutRequest.findMany({
    orderBy: [{ status: "asc" }, { eligibleAt: "asc" }],
    take: 300,
    include: { provider: { select: { id: true, displayName: true, payoutDetailsEncrypted: true } } },
  });
  return payouts.map(({ provider, ...payout }) => ({
    ...payout,
    provider: {
      id: provider.id,
      displayName: provider.displayName,
      destination: provider.payoutDetailsEncrypted
        ? JSON.parse(
            unseal(provider.payoutDetailsEncrypted, "payout-details:" + provider.id).toString("utf8"),
          )
        : null,
    },
  }));
}

export async function processPayouts(actorId: string, input: PayoutAction, now = new Date()) {
  if (new Set(input.payoutIds).size !== input.payoutIds.length)
    throw new HttpError(400, "Each payout can appear only once.");
  return db.$transaction(async (tx) => {
    const updated: PayoutRequest[] = [];
    for (const payoutId of input.payoutIds) {
      const candidate = await tx.payoutRequest.findUnique({ where: { id: payoutId } });
      if (!candidate) throw new HttpError(404, "A payout request was not found.");
      await lockFinanceProvider(tx, candidate.providerId);
      const payout = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutId } });
      let status: PayoutRequest["status"];
      if (input.action === "APPROVE" && payout.status === "APPROVED") {
        updated.push(payout);
        continue;
      }
      if (input.action === "REJECT" && payout.status === "FAILED" && payout.failureNote === input.reason) {
        updated.push(payout);
        continue;
      }
      if (input.action === "RETRY" && payout.status === "APPROVED") {
        updated.push(payout);
        continue;
      }
      if (input.action === "MARK_PAID" && payout.status === "PAID" && payout.reference === input.reference) {
        updated.push(payout);
        continue;
      }
      if (input.action === "APPROVE" && payout.status === "PENDING") status = "APPROVED";
      else if (input.action === "REJECT" && payout.status === "PENDING") status = "FAILED";
      else if (input.action === "RETRY" && payout.status === "FAILED") status = "APPROVED";
      else if (input.action === "MARK_PAID" && payout.status === "APPROVED") status = "PAID";
      else throw new HttpError(409, "This payout status no longer allows that action.");
      if (input.action === "APPROVE" && payout.eligibleAt > now) {
        throw new HttpError(409, "This payout is not eligible until its configured payout cycle begins.");
      }
      if (input.action === "APPROVE" || input.action === "RETRY") {
        const profile = await tx.providerProfile.findUniqueOrThrow({
          where: { id: payout.providerId },
          select: { payoutDetailsEncrypted: true },
        });
        if (!profile.payoutDetailsEncrypted)
          throw new HttpError(409, "The provider has no payout destination.");
      }
      if (input.action === "MARK_PAID") {
        const balance = await groupedBalance(tx, payout.providerId);
        if (payout.amountPaise > balance.payablePaise - balance.duesPaise)
          throw new HttpError(409, "This payout is no longer backed by available earnings.");
        const taxPaidPaise = Math.min(payout.amountPaise, Math.max(0, balance.taxPayablePaise));
        const providerNetPaidPaise = payout.amountPaise - taxPaidPaise;
        await postLedgerBatch(tx, {
          reference: "payout:" + payout.id,
          source: "PAYOUT_PAID",
          providerId: payout.providerId,
          actorId,
          lines: [
            { account: "PROVIDER_PAYABLE", amountPaise: providerNetPaidPaise },
            { account: "TAX_PAYABLE", amountPaise: taxPaidPaise },
            { account: "GATEWAY_CLEARING", amountPaise: -payout.amountPaise },
          ],
        });
      }
      const next = await tx.payoutRequest.update({
        where: { id: payout.id },
        data: {
          status,
          ...(input.action === "MARK_PAID"
            ? { reference: input.reference, failureNote: null }
            : input.action === "REJECT"
              ? { failureNote: input.reason }
              : input.action === "RETRY"
                ? { failureNote: null }
                : {}),
          ...(input.action === "APPROVE" || input.action === "RETRY" || input.action === "MARK_PAID"
            ? { approvedBy: actorId }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId: payout.providerId,
          action: "ADMIN_PAYOUT_" + input.action,
          metadata: {
            payoutId: payout.id,
            amountPaise: payout.amountPaise,
            currency,
            reason: input.action === "REJECT" ? input.reason : undefined,
            reference: input.action === "MARK_PAID" ? input.reference : undefined,
          },
        },
      });
      if (input.action === "MARK_PAID") {
        const owner = await tx.providerProfile.findUniqueOrThrow({
          where: { id: payout.providerId },
          select: { ownerId: true },
        });
        await enqueueEvent(tx, {
          userId: owner.ownerId,
          eventType: "PAYOUT_PAID",
          title: "Payout sent",
          body: `A provider payout of INR ${Math.floor(payout.amountPaise / 100)}.${String(payout.amountPaise % 100).padStart(2, "0")} was marked paid.`,
          idempotencyKey: `payout-paid:${payout.id}`,
        });
      }
      updated.push(next);
    }
    return updated;
  });
}

export async function updateFinanceSettings(
  actorId: string,
  input: z.infer<typeof commissionSettingsSchema>,
) {
  return db.$transaction(async (tx) => {
    const settings = await tx.financeSetting.update({ where: { id: "platform" }, data: input });
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: "platform",
        action: "ADMIN_FINANCE_SETTINGS_CHANGED",
        metadata: { ...input, currency },
      },
    });
    return settings;
  });
}

export async function updateCommissionOverride(
  actorId: string,
  input: z.infer<typeof commissionOverrideSchema>,
) {
  return db.$transaction(async (tx) => {
    if (input.scope === "CATEGORY") {
      const category = await tx.serviceCategory.findUnique({ where: { id: input.id } });
      if (!category) throw new HttpError(404, "Service category not found.");
      const updated = await tx.serviceCategory.update({
        where: { id: input.id },
        data: { commissionBps: input.commissionBps },
        select: { id: true, name: true, commissionBps: true },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId: category.id,
          action: "ADMIN_COMMISSION_OVERRIDE_CHANGED",
          metadata: { scope: input.scope, commissionBps: input.commissionBps },
        },
      });
      return updated;
    }
    const updated = await tx.providerProfile
      .update({
        where: { id: input.id },
        data: { commissionBps: input.commissionBps },
        select: { id: true, displayName: true, commissionBps: true },
      })
      .catch(() => {
        throw new HttpError(404, "Provider not found.");
      });
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: updated.id,
        action: "ADMIN_COMMISSION_OVERRIDE_CHANGED",
        metadata: { scope: input.scope, commissionBps: input.commissionBps },
      },
    });
    return updated;
  });
}

export async function adminFinanceSummary() {
  const [settings, balances, paid, pending, bookingGross, paymentCapture, originalRefunds] =
    await Promise.all([
      db.financeSetting.findUniqueOrThrow({ where: { id: "platform" } }),
      db.ledgerEntry.groupBy({ by: ["account"], _sum: { amountPaise: true } }),
      db.payoutRequest.aggregate({ where: { status: "PAID" }, _sum: { amountPaise: true } }),
      db.payoutRequest.aggregate({
        where: { status: { in: ["PENDING", "APPROVED"] } },
        _sum: { amountPaise: true },
      }),
      db.booking.aggregate({
        where: { status: { in: ["COMPLETED", "NO_SHOW"] } },
        _sum: { totalPaise: true },
      }),
      db.payment.aggregate({
        _sum: { gatewayCapturedPaise: true, gatewayFeePaise: true, refundedPaise: true },
      }),
      db.refund.aggregate({
        where: { status: "PROCESSED", destination: "ORIGINAL" },
        _sum: { gatewayPaise: true },
      }),
    ]);
  const sum = (account: LedgerAccount) =>
    balances.find((entry) => entry.account === account)?._sum.amountPaise ?? 0;
  const gatewayCapturedPaise = paymentCapture._sum.gatewayCapturedPaise ?? 0;
  const gatewayFeesPaise = paymentCapture._sum.gatewayFeePaise ?? 0;
  const gatewayRefundedPaise = originalRefunds._sum.gatewayPaise ?? 0;
  const payoutsPaidPaise = paid._sum.amountPaise ?? 0;
  const gatewayLedgerBalancePaise = sum("GATEWAY_CLEARING");
  const expectedGatewayBalancePaise =
    gatewayCapturedPaise - gatewayRefundedPaise - gatewayFeesPaise - payoutsPaidPaise;
  return {
    settings,
    currency,
    gmvPaise: bookingGross._sum.totalPaise ?? 0,
    commissionPaise: -sum("PLATFORM_REVENUE"),
    providerPayablePaise: -sum("PROVIDER_PAYABLE"),
    taxPayablePaise: -sum("TAX_PAYABLE"),
    totalProviderObligationPaise: -sum("PROVIDER_PAYABLE") - sum("TAX_PAYABLE"),
    providerDuesPaise: sum("PROVIDER_DUES"),
    payoutsPaidPaise,
    pendingPayoutPaise: pending._sum.amountPaise ?? 0,
    gatewayCapturedPaise,
    gatewayFeesPaise,
    gatewayRefundedPaise,
    paymentRefundedPaise: paymentCapture._sum.refundedPaise ?? 0,
    gatewayLedgerBalancePaise,
    expectedGatewayBalancePaise,
    gatewayDifferencePaise: gatewayLedgerBalancePaise - expectedGatewayBalancePaise,
    reconciliation: Object.fromEntries(balances.map((entry) => [entry.account, entry._sum.amountPaise ?? 0])),
  };
}

export { commissionOverrideSchema, commissionSettingsSchema, payoutActionSchema, payoutDetailsSchema };
