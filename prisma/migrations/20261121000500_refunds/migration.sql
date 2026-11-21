-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "cancellationFeeBps" INTEGER NOT NULL DEFAULT 2500,
ADD COLUMN     "freeRefundHours" INTEGER,
ADD COLUMN     "noRefundHours" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "noShowFeeBps" INTEGER NOT NULL DEFAULT 10000;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "cancellationFeeBps" INTEGER NOT NULL DEFAULT 2500,
ADD COLUMN     "freeRefundHours" INTEGER,
ADD COLUMN     "noRefundHours" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "noShowFeeBps" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN     "retainedFeePaise" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "BookingChange" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "oldTotalPaise" INTEGER NOT NULL,
    "newTotalPaise" INTEGER NOT NULL,
    "refundPaise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingChange_bookingId_requestKey_key" ON "BookingChange"("bookingId", "requestKey");

-- CreateIndex
CREATE INDEX "Refund_status_nextAttemptAt_idx" ON "Refund"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "BookingChange" ADD CONSTRAINT "BookingChange_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderProfile" ADD CONSTRAINT "provider_cancellation_policy_valid" CHECK (
  "noRefundHours" BETWEEN 0 AND COALESCE("freeRefundHours", "cancelBeforeHours") AND
  ("freeRefundHours" IS NULL OR "freeRefundHours" BETWEEN 0 AND 168) AND
  "cancellationFeeBps" BETWEEN 0 AND 10000 AND "noShowFeeBps" BETWEEN 0 AND 10000
);
ALTER TABLE "BookingChange" ADD CONSTRAINT "booking_change_amounts_valid" CHECK (
  "currency" = 'INR' AND "oldTotalPaise" >= 0 AND "newTotalPaise" >= 0 AND "refundPaise" >= 0
);
