-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "CouponUseStatus" AS ENUM ('RESERVED', 'COMPLETED', 'RELEASED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "loyaltyDiscountPaise" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "discountType" "CouponDiscountType" NOT NULL DEFAULT 'PERCENT';

-- AlterTable
ALTER TABLE "CouponUsage" ADD COLUMN     "status" "CouponUseStatus" NOT NULL DEFAULT 'RESERVED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referredByCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredByCodeId_fkey" FOREIGN KEY ("referredByCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "Coupon" DROP CONSTRAINT "coupon_rules_valid";
ALTER TABLE "Coupon" ADD CONSTRAINT "coupon_rules_valid" CHECK (
  "amount" > 0 AND "minCartPaise" >= 0 AND "perUserLimit" >= 1 AND "usageCount" >= 0 AND
  ("totalUses" IS NULL OR "totalUses" >= 1) AND
  ("maxDiscountPaise" IS NULL OR "maxDiscountPaise" > 0) AND "validUntil" > "validFrom" AND
  (("kind" = 'CATEGORY' AND "categoryId" IS NOT NULL) OR ("kind" <> 'CATEGORY')) AND
  (("kind" = 'PROVIDER' AND "providerId" IS NOT NULL) OR ("kind" <> 'PROVIDER')) AND
  (("discountType" = 'PERCENT' AND "amount" BETWEEN 1 AND 10000) OR ("discountType" = 'FLAT' AND "amount" > 0))
);
ALTER TABLE "Booking" ADD CONSTRAINT "booking_loyalty_discount_valid"
  CHECK ("loyaltyDiscountPaise" >= 0 AND "loyaltyDiscountPaise" <= "discountPaise");
