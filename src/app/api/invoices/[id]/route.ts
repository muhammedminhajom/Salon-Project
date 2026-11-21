import { requireUser } from "@/lib/auth";
import { getInvoice, renderInvoicePdf } from "@/lib/invoices";
import { HttpError, route } from "@/lib/http";

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const invoice = await getInvoice((await context.params).id);
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  const allowed =
    user.role === "ADMIN" ||
    (user.role === "CUSTOMER" && user.id === invoice.booking.customerId) ||
    (user.role === "PROVIDER" && user.id === invoice.booking.provider.ownerId);
  if (!allowed) throw new HttpError(404, "Invoice not found.");
  const pdf = renderInvoicePdf(invoice);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoice.invoiceNumber.replaceAll("/", "-")}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
