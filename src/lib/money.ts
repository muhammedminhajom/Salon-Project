import type { PaymentMode } from "@prisma/client";

export const currency = "INR" as const;
export const defaultDepositBps = 2500;
export const maxStoredPaise = 2_147_483_647;

export function portion(paise: number, bps: number) {
  return Number((BigInt(paise) * BigInt(bps) + 5000n) / 10_000n);
}

export function priceCheckout(input: {
  servicePaise: number;
  travelPaise: number;
  taxRateBps: number;
  depositBps: number | null;
  paymentMode: PaymentMode;
  availableWalletPaise: number;
  discountPaise?: number;
}) {
  const subtotalPaise = input.servicePaise + input.travelPaise;
  const discountPaise = Math.min(subtotalPaise, input.discountPaise ?? 0);
  const taxPaise = portion(subtotalPaise - discountPaise, input.taxRateBps);
  const totalPaise = subtotalPaise - discountPaise + taxPaise;
  const payable =
    input.paymentMode === "DEPOSIT"
      ? Math.min(totalPaise, Math.max(100, portion(totalPaise, input.depositBps ?? defaultDepositBps)))
      : totalPaise;
  const offeredWalletPaise = Math.min(payable, input.availableWalletPaise);
  const remainder = payable - offeredWalletPaise;
  const walletUsedPaise =
    input.paymentMode !== "PAY_AT_VENUE" && remainder > 0 && remainder < 100
      ? Math.max(0, payable - 100)
      : offeredWalletPaise;
  const gatewayAmountPaise = input.paymentMode === "PAY_AT_VENUE" ? 0 : payable - walletUsedPaise;
  return {
    currency,
    subtotalPaise,
    servicePaise: input.servicePaise,
    travelPaise: input.travelPaise,
    discountPaise,
    taxPaise,
    taxRateBps: input.taxRateBps,
    totalPaise,
    walletUsedPaise,
    gatewayAmountPaise,
    dueAtVenuePaise: totalPaise - gatewayAmountPaise - walletUsedPaise,
  };
}
