import { limit, requireUser } from "@/lib/auth";
import { cancelAppointment, previewCancellation } from "@/lib/bookings";
import { json, respond, route } from "@/lib/http";
import { cancelAppointmentSchema } from "@/lib/schemas";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request, { params }: Context) => {
  const user = await requireUser();
  return respond({ preview: await previewCancellation((await params).id, user) });
});

export const POST = route(async (request, { params }: Context) => {
  const user = await requireUser();
  await limit("booking-cancel", user.id, 30, 300);
  const input = await json(request, cancelAppointmentSchema);
  return respond({ booking: await cancelAppointment((await params).id, user, input) });
});
