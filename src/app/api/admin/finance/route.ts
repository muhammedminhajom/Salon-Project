import { requireUser, limit } from "@/lib/auth";
import { db } from "@/lib/db";
import { adminFinanceSummary, updateFinanceSettings } from "@/lib/finance";
import { json, respond, route } from "@/lib/http";
import { commissionSettingsSchema } from "@/lib/schemas";

export const GET = route(async (request) => {
  await requireUser("ADMIN");
  const summary = await adminFinanceSummary();
  if (new URL(request.url).searchParams.get("format") === "csv") {
    const rows = [
      ["Metric", "Amount (paise)", "Currency"],
      ["GMV", summary.gmvPaise],
      ["Commission earned", summary.commissionPaise],
      ["Provider net payable", summary.providerPayablePaise],
      ["Provider tax payable", summary.taxPayablePaise],
      ["Total provider obligation", summary.totalProviderObligationPaise],
      ["Provider dues", summary.providerDuesPaise],
      ["Payouts paid", summary.payoutsPaidPaise],
      ["Gateway ledger balance", summary.gatewayLedgerBalancePaise],
    ];
    const csv = rows
      .map((row) => row.map((cell) => '"' + String(cell).replaceAll('"', '""') + '"').join(","))
      .join("\r\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="platform-finance.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  const [categories, providers, pendingPayouts] = await Promise.all([
    db.serviceCategory.findMany({
      orderBy: { position: "asc" },
      select: { id: true, name: true, commissionBps: true },
    }),
    db.providerProfile.findMany({
      where: { status: "APPROVED" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true, commissionBps: true },
      take: 500,
    }),
    db.payoutRequest.count({ where: { status: { in: ["PENDING", "APPROVED"] } } }),
  ]);
  return respond({ ...summary, categories, providers, pendingPayouts });
});

export const PUT = route(async (request) => {
  const user = await requireUser("ADMIN");
  await limit("admin-finance-settings", user.id, 30, 300);
  const settings = await updateFinanceSettings(user.id, await json(request, commissionSettingsSchema));
  return respond({ settings });
});
