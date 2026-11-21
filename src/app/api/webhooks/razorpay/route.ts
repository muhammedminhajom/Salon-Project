import { bodyBytes, respond, route } from "@/lib/http";
import { receiveGatewayWebhook } from "@/lib/payments";

export const POST = route(async (request) =>
  respond(
    await receiveGatewayWebhook(
      await bodyBytes(request, 256_000),
      request.headers.get("x-razorpay-signature") ?? "",
      request.headers.get("x-razorpay-event-id") ?? "",
    ),
  ),
);
