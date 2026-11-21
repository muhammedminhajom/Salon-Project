import { limitAddress } from "@/lib/auth";
import { getAvailability } from "@/lib/bookings";
import { json, respond, route } from "@/lib/http";
import { availabilitySchema } from "@/lib/schemas";

export const POST = route(async (request) => {
  await limitAddress(request, "availability-ip", 180, 60);
  return respond(await getAvailability(await json(request, availabilitySchema)));
});
