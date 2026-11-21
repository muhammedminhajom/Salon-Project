"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api, jsonRequest } from "@/lib/client";
import { money } from "@/lib/utils";

type GatewayOrder = { keyId: string; amount: number; orderId: string; currency: string };
type CheckoutResult = { status: string; bookingStatus: string };
type GatewayCallback = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};
type RazorpayCheckout = Window & {
  Razorpay?: new (options: {
    key: string;
    amount: number;
    currency: string;
    order_id: string;
    name: string;
    handler: (result: GatewayCallback) => void;
    modal: { ondismiss: () => void };
  }) => { open: () => void };
};

let checkoutScript: Promise<void> | undefined;
function loadGateway() {
  checkoutScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      checkoutScript = undefined;
      reject(new Error("Could not load Razorpay Checkout. Try again."));
    };
    document.head.append(script);
  });
  return checkoutScript;
}

export function CheckoutPayment({
  bookingId,
  amount,
  onResult,
}: {
  bookingId: string;
  amount: number;
  onResult?: (result: CheckoutResult) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function verify(result: GatewayCallback) {
    try {
      const verified = await api<CheckoutResult>(
        "/api/payments",
        jsonRequest("POST", {
          action: "verify",
          bookingId,
          orderId: result.razorpay_order_id,
          paymentId: result.razorpay_payment_id,
          signature: result.razorpay_signature,
        }),
      );
      setMessage(
        verified.status === "PENDING"
          ? "Waiting for the payment confirmation."
          : verified.bookingStatus === "CANCELLED"
            ? "The hold expired. The payment was handled as a refund."
            : "Payment received.",
      );
      onResult?.(verified);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const order = await api<GatewayOrder>(
        "/api/payments",
        jsonRequest("POST", { action: "order", bookingId }),
      );
      await loadGateway();
      const Checkout = (window as RazorpayCheckout).Razorpay;
      if (!Checkout) throw new Error("Razorpay Checkout is unavailable.");
      new Checkout({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: "Bloom & Blush",
        handler: (result) => void verify(result),
        modal: { ondismiss: () => setBusy(false) },
      }).open();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="form-stack">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <Button type="button" disabled={busy} onClick={pay}>
        {busy ? "Opening checkout…" : "Pay " + money(amount)}
      </Button>
    </div>
  );
}
