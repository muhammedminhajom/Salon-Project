-- AlterTable
ALTER TABLE "FinanceSetting" ADD COLUMN     "referralRewardPaise" INTEGER NOT NULL DEFAULT 5000;

-- AlterTable
ALTER TABLE "Notifications" ADD COLUMN     "subject" TEXT NOT NULL DEFAULT '';


ALTER TABLE "FinanceSetting" DROP CONSTRAINT "finance_setting_valid";
ALTER TABLE "FinanceSetting" ADD CONSTRAINT "finance_setting_valid" CHECK (
  "defaultCommissionBps" BETWEEN 0 AND 10000 AND
  "minimumPayoutPaise" BETWEEN 50000 AND 2147483647 AND
  "payoutCycleDays" BETWEEN 1 AND 31 AND
  "loyaltyPointsPerVisit" BETWEEN 0 AND 100000 AND
  "loyaltyPaisePerPoint" BETWEEN 1 AND 100000 AND
  "loyaltyExpiryDays" BETWEEN 30 AND 3650 AND
  "referralRewardPaise" BETWEEN 0 AND 2147483647
);
