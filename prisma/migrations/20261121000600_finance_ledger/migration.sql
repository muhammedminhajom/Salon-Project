ALTER TABLE "ProviderProfile"
  ADD COLUMN "commissionBps" INTEGER,
  ADD COLUMN "payoutDetailsEncrypted" BYTEA;

ALTER TABLE "ProviderProfile" ADD CONSTRAINT "provider_commission_valid"
  CHECK ("commissionBps" IS NULL OR "commissionBps" BETWEEN 0 AND 10000);

ALTER TABLE "ServiceCategory" ADD COLUMN "commissionBps" INTEGER;
ALTER TABLE "ServiceCategory" ADD CONSTRAINT "category_commission_valid"
  CHECK ("commissionBps" IS NULL OR "commissionBps" BETWEEN 0 AND 10000);

ALTER TABLE "BookingItem" ADD COLUMN "commissionBps" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "BookingItem" ADD CONSTRAINT "booking_item_commission_valid"
  CHECK ("commissionBps" BETWEEN 0 AND 10000);

CREATE TYPE "LedgerAccount" AS ENUM (
  'CUSTOMER_FUNDS',
  'CUSTOMER_RECEIVABLE',
  'GATEWAY_CLEARING',
  'PROVIDER_PAYABLE',
  'PROVIDER_DUES',
  'PLATFORM_REVENUE',
  'GATEWAY_FEE',
  'REFUND_EXPENSE',
  'WALLET_LIABILITY'
);

CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'FAILED');

CREATE TABLE "FinanceSetting" (
  "id" TEXT NOT NULL DEFAULT 'platform',
  "defaultCommissionBps" INTEGER NOT NULL DEFAULT 1000,
  "minimumPayoutPaise" INTEGER NOT NULL DEFAULT 50000,
  "payoutCycleDays" INTEGER NOT NULL DEFAULT 7,
  "loyaltyPointsPerVisit" INTEGER NOT NULL DEFAULT 10,
  "loyaltyPaisePerPoint" INTEGER NOT NULL DEFAULT 100,
  "loyaltyExpiryDays" INTEGER NOT NULL DEFAULT 365,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceSetting_pkey" PRIMARY KEY ("id")
);

INSERT INTO "FinanceSetting" ("id") VALUES ('platform') ON CONFLICT DO NOTHING;

CREATE TABLE "LedgerBatch" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LedgerEntry" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "account" "LedgerAccount" NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  "providerId" TEXT,
  "bookingId" TEXT,
  "staffId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entry_money_valid" CHECK ("currency" = 'INR' AND "amountPaise" <> 0)
);

CREATE TABLE "PayoutRequest" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "failureNote" TEXT,
  "approvedBy" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_request_money_valid" CHECK ("currency" = 'INR' AND "amountPaise" >= 50000)
);

CREATE UNIQUE INDEX "LedgerBatch_reference_key" ON "LedgerBatch"("reference");
CREATE UNIQUE INDEX "LedgerEntry_batchId_account_key" ON "LedgerEntry"("batchId", "account");
CREATE INDEX "LedgerEntry_providerId_account_createdAt_idx"
  ON "LedgerEntry"("providerId", "account", "createdAt");
CREATE INDEX "LedgerEntry_bookingId_createdAt_idx" ON "LedgerEntry"("bookingId", "createdAt");
CREATE INDEX "LedgerEntry_staffId_account_createdAt_idx"
  ON "LedgerEntry"("staffId", "account", "createdAt");
CREATE UNIQUE INDEX "PayoutRequest_reference_key" ON "PayoutRequest"("reference");
CREATE UNIQUE INDEX "PayoutRequest_providerId_requestKey_key"
  ON "PayoutRequest"("providerId", "requestKey");
CREATE INDEX "PayoutRequest_status_createdAt_idx" ON "PayoutRequest"("status", "createdAt");

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "LedgerBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinanceSetting" ADD CONSTRAINT "finance_setting_valid"
  CHECK (
    "defaultCommissionBps" BETWEEN 0 AND 10000 AND
    "minimumPayoutPaise" BETWEEN 50000 AND 2147483647 AND
    "payoutCycleDays" BETWEEN 1 AND 31 AND
    "loyaltyPointsPerVisit" BETWEEN 0 AND 100000 AND
    "loyaltyPaisePerPoint" BETWEEN 1 AND 100000 AND
    "loyaltyExpiryDays" BETWEEN 30 AND 3650
  );
