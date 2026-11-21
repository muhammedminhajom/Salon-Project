ALTER TABLE "Booking" ADD COLUMN "walkInKey" TEXT;

CREATE UNIQUE INDEX "Booking_providerId_walkInKey_key" ON "Booking"("providerId", "walkInKey");
