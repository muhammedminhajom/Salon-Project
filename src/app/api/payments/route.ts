import { limit, requireUser } from "@/lib/auth";
import { getCheckoutQuote } from "@/lib/bookings";
import { db } from "@/lib/db";
import { HttpError, json, respond, route } from "@/lib/http";
import { createGatewayOrder, verifyGatewayPayment } from "@/lib/payments";
import { razorpayEnabled } from "@/lib/razorpay";
import { paymentActionSchema } from "@/lib/schemas";

export const GET = route(async () => {
  const user = await requireUser("CUSTOMER");
  const wallet = await db.wallet.findUnique({ where: { userId: user.id }, select: { balancePaise: true } });
  return respond({
    balancePaise: wallet?.balancePaise ?? 0,
    currency: "INR",
    onlineEnabled: razorpayEnabled(),
  });
});

export const POST = route(async (request) => {
  const { id } = await requireUser("CUSTOMER");
  await limit("payment-action", id, 60, 300);
  const input = await json(request, paymentActionSchema);
  if (input.action === "quote")
    return respond({ quote: await getCheckoutQuote(id, input.selection), onlineEnabled: razorpayEnabled() });
  if (input.action === "verify") return respond(await verifyGatewayPayment(id, input));
  if (!razorpayEnabled()) throw new HttpError(503, "Online payments are unavailable.");
  return respond({ ...(await createGatewayOrder(input.bookingId, id)), keyId: process.env.RAZORPAY_KEY_ID });
});
