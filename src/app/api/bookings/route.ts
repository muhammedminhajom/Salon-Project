import { limit, requireUser } from "@/lib/auth";
import { createBooking, listBookings } from "@/lib/bookings";
import { HttpError, json, respond, route } from "@/lib/http";
import { razorpayEnabled } from "@/lib/razorpay";
import { bookingSchema } from "@/lib/schemas";

export const GET = route(async () => respond({ bookings: await listBookings(await requireUser()) }));

export const POST = route(async (request) => {
  const user = await requireUser("CUSTOMER");
  await limit("booking-create", user.id, 30, 300);
  const input = await json(request, bookingSchema);
  if (input.paymentMode && input.paymentMode !== "PAY_AT_VENUE" && !razorpayEnabled())
    throw new HttpError(503, "Online payments are unavailable. Select pay at venue.");
  const result = await createBooking(user.id, input);
  return respond({ booking: result.booking }, result.created ? 201 : 200);
});
