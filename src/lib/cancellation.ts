import { portion } from "@/lib/money";

export type CancellationPolicy = {
  cancelBeforeHours: number;
  freeRefundHours: number | null;
  noRefundHours: number;
  cancellationFeeBps: number;
  noShowFeeBps: number;
};

export function cancellationQuote(input: {
  policy: CancellationPolicy;
  totalPaise: number;
  availablePaise: number;
  minutesBefore: number;
  reason: "CUSTOMER_CANCEL" | "PROVIDER_CANCEL" | "NO_SHOW" | "HOLD_RELEASE";
}) {
  const { policy } = input;
  const free = (policy.freeRefundHours ?? policy.cancelBeforeHours) * 60;
  let rate = 0;
  if (input.reason === "NO_SHOW") rate = policy.noShowFeeBps;
  if (input.reason === "CUSTOMER_CANCEL" && input.minutesBefore < free) {
    rate = input.minutesBefore <= policy.noRefundHours * 60 ? 10_000 : policy.cancellationFeeBps;
  }
  const feePaise = portion(input.totalPaise, rate);
  const retainedPaise = Math.min(feePaise, input.availablePaise);
  return { feePaise, retainedPaise, refundPaise: input.availablePaise - retainedPaise };
}
