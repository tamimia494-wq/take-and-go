CREATE TYPE "BookingOptionKind" AS ENUM ('ADDON', 'FIELD');

CREATE TABLE "BookingCustomer" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingCustomer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "basePriceFils" INTEGER NOT NULL DEFAULT 0,
    "rearSeatPriceFils" INTEGER NOT NULL DEFAULT 0,
    "whatsappNumber" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingLocation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingOption" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "BookingOptionKind" NOT NULL DEFAULT 'ADDON',
    "priceFils" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "pickupLocation" TEXT NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "pickupLatitude" DOUBLE PRECISION,
    "pickupLongitude" DOUBLE PRECISION,
    "destinationLocation" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "destinationLatitude" DOUBLE PRECISION,
    "destinationLongitude" DOUBLE PRECISION,
    "passengerCount" INTEGER NOT NULL,
    "rearSeat" BOOLEAN NOT NULL DEFAULT false,
    "selections" JSONB NOT NULL,
    "totalPriceFils" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingCustomer_phone_key" ON "BookingCustomer"("phone");
CREATE INDEX "BookingLocation_active_sortOrder_idx" ON "BookingLocation"("active", "sortOrder");
CREATE INDEX "BookingOption_active_sortOrder_idx" ON "BookingOption"("active", "sortOrder");
CREATE INDEX "Booking_createdAt_idx" ON "Booking"("createdAt");
CREATE INDEX "Booking_customerId_createdAt_idx" ON "Booking"("customerId", "createdAt");

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "BookingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
