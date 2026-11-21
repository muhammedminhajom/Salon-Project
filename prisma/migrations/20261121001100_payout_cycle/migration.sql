ALTER TABLE "PayoutRequest"
ADD COLUMN "eligibleAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "PayoutRequest_status_eligibleAt_idx"
ON "PayoutRequest"("status", "eligibleAt");
