import { requireUser } from "@/lib/auth";
import { z } from "zod";
import { changeBooking, rescheduleBooking, rescheduleTimes } from "@/lib/bookings";
import { json, respond, route } from "@/lib/http";
import { bookingStatusSchema, rescheduleSchema } from "@/lib/schemas";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await params;
  const date = z.iso.date().parse(new URL(request.url).searchParams.get("date"));
  return respond(await rescheduleTimes(id, user, date));
});

export const PATCH = route(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await params;
  const { status } = await json(request, bookingStatusSchema);
  return respond({ booking: await changeBooking(id, user, status) });
});

export const PUT = route(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await params;
  return respond({ booking: await rescheduleBooking(id, user, await json(request, rescheduleSchema)) });
});
