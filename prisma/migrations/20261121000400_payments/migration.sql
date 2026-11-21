-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('FULL_ONLINE', 'DEPOSIT', 'PAY_AT_VENUE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "RefundDestination" AS ENUM ('ORIGINAL', 'WALLET');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "depositBps" INTEGER,
ADD COLUMN     "gstRateBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gstin" TEXT;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "confirmAfterPayment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "holdExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "paymentMode" "PaymentMode" NOT NULL DEFAULT 'PAY_AT_VENUE',
ADD COLUMN     "supplierGstin" TEXT,
ADD COLUMN     "taxPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxRateBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "gatewayAmountPaise" INTEGER NOT NULL,
    "gatewayCapturedPaise" INTEGER NOT NULL DEFAULT 0,
    "gatewayFeePaise" INTEGER NOT NULL DEFAULT 0,
    "walletUsedPaise" INTEGER NOT NULL,
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "dueAtVenuePaise" INTEGER NOT NULL,
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "lateCapture" BOOLEAN NOT NULL DEFAULT false,
    "orderClaimedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "userId" TEXT NOT NULL,
    "balancePaise" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "balancePaise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "reason" TEXT NOT NULL,
    "destination" "RefundDestination" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "amountPaise" INTEGER NOT NULL,
    "gatewayPaise" INTEGER NOT NULL,
    "walletPaise" INTEGER NOT NULL,
    "gatewayRefundId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "gatewayPaymentId" TEXT,
    "gatewayRefundId" TEXT,
    "amountPaise" INTEGER,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_bookingId_key" ON "Payment"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayOrderId_key" ON "Payment"("gatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayPaymentId_key" ON "Payment"("gatewayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletEntry_reference_key" ON "WalletEntry"("reference");

-- CreateIndex
CREATE INDEX "WalletEntry_userId_createdAt_idx" ON "WalletEntry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_gatewayRefundId_key" ON "Refund"("gatewayRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_requestKey_key" ON "Refund"("paymentId", "requestKey");

-- CreateIndex
CREATE INDEX "GatewayEvent_gatewayPaymentId_appliedAt_idx" ON "GatewayEvent"("gatewayPaymentId", "appliedAt");

-- CreateIndex
CREATE INDEX "Booking_holdExpiresAt_idx" ON "Booking"("holdExpiresAt");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Wallet"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderProfile" ADD CONSTRAINT "provider_payment_settings_valid" CHECK (
  ("depositBps" IS NULL OR "depositBps" BETWEEN 100 AND 9900) AND
  ("gstRateBps" BETWEEN 0 AND 10000) AND
  (("gstRegistered" AND "gstin" IS NOT NULL) OR (NOT "gstRegistered" AND "gstin" IS NULL AND "gstRateBps" = 0))
);
ALTER TABLE "Booking" ADD CONSTRAINT "booking_money_valid" CHECK (
  "currency" = 'INR' AND "taxPaise" >= 0 AND "taxPaise" <= "totalPaise" AND
  ("holdExpiresAt" IS NULL OR ("status" = 'PENDING' AND "paymentMode" <> 'PAY_AT_VENUE'))
);
ALTER TABLE "Payment" ADD CONSTRAINT "payment_money_valid" CHECK (
  "currency" = 'INR' AND "gatewayAmountPaise" >= 0 AND
  "gatewayCapturedPaise" BETWEEN 0 AND "gatewayAmountPaise" AND "walletUsedPaise" >= 0 AND
  "gatewayFeePaise" >= 0 AND "dueAtVenuePaise" >= 0 AND
  "refundedPaise" BETWEEN 0 AND ("gatewayCapturedPaise" + "walletUsedPaise")
);
ALTER TABLE "Refund" ADD CONSTRAINT "refund_money_valid" CHECK (
  "currency" = 'INR' AND "amountPaise" > 0 AND "gatewayPaise" >= 0 AND "walletPaise" >= 0
  AND "amountPaise" = "gatewayPaise" + "walletPaise"
);
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_money_valid" CHECK ("currency" = 'INR' AND "balancePaise" >= 0);
ALTER TABLE "WalletEntry" ADD CONSTRAINT "wallet_entry_money_valid" CHECK (
  "currency" = 'INR' AND "amountPaise" <> 0 AND "balancePaise" >= 0
);
