import { limit, requireUser } from "@/lib/auth";
import { getCheckoutQuote } from "@/lib/bookings";
import { HttpError, json, respond, route } from "@/lib/http";
import { checkoutQuoteSchema } from "@/lib/schemas";

export const POST = route(async (request) => {
  const user = await requireUser("CUSTOMER");
  await limit("coupon-validation", user.id, 30, 300);
  const input = await json(request, checkoutQuoteSchema);
  if (!input.couponCode) throw new HttpError(400, "Enter a coupon code.");
  return respond({ quote: await getCheckoutQuote(user.id, input) });
});
