import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/http";
import { gatewayId, razorpayPaymentSchema, razorpayRefundSchema, whole } from "@/lib/schemas";

const orderSchema = z.object({
  id: gatewayId,
  receipt: z.string(),
  amount: whole(100, 100_000_000),
  currency: z.literal("INR"),
});

export type GatewayOrder = z.infer<typeof orderSchema>;
export type GatewayPayment = z.infer<typeof razorpayPaymentSchema>;
export type GatewayRefund = z.infer<typeof razorpayRefundSchema>;

export function razorpayEnabled() {
  return Boolean(
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET,
  );
}

export function validGatewaySignature(body: string | Buffer, signature: string, secret: string) {
  return (
    /^[\da-f]{64}$/i.test(signature) &&
    timingSafeEqual(createHmac("sha256", secret).update(body).digest(), Buffer.from(signature, "hex"))
  );
}

async function request<T>(path: string, schema: z.ZodType<T>, input?: object, refundKey?: string) {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) throw new HttpError(503, "Online payments are unavailable.");
  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64"),
    "Content-Type": "application/json",
  };
  if (refundKey) headers["X-Refund-Idempotency"] = refundKey;
  const unavailable = new HttpError(
    502,
    "Razorpay did not confirm the request. You can retry.",
    "GATEWAY_ERROR",
  );
  const response = await fetch("https://api.razorpay.com/v1" + path, {
    method: input ? "POST" : "GET",
    body: input && JSON.stringify(input),
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    throw unavailable;
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable;
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw unavailable;
  return parsed.data;
}

export const razorpay = {
  async findOrder(receipt: string): Promise<GatewayOrder | undefined> {
    const query = new URLSearchParams({ receipt, count: "2" });
    const { items } = await request("/orders?" + query, z.object({ items: z.array(orderSchema) }));
    if (items.length > 1) throw new HttpError(409, "More than one gateway order matched this checkout.");
    return items[0];
  },
  createOrder(receipt: string, amount: number) {
    return request("/orders", orderSchema, { amount, currency: "INR", receipt, partial_payment: false });
  },
  fetchPayment(paymentId: string) {
    return request("/payments/" + encodeURIComponent(paymentId), razorpayPaymentSchema);
  },
  fetchRefund(paymentId: string, refundId: string) {
    return request(
      "/payments/" + encodeURIComponent(paymentId) + "/refunds/" + encodeURIComponent(refundId),
      razorpayRefundSchema,
    );
  },
  refund(paymentId: string, refundId: string, amount: number) {
    return request(
      "/payments/" + encodeURIComponent(paymentId) + "/refund",
      razorpayRefundSchema,
      {
        amount,
        speed: "normal",
        receipt: refundId,
        notes: { refund_id: refundId },
      },
      refundId,
    );
  },
};
