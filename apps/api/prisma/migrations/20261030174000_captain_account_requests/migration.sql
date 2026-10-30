CREATE TYPE "CaptainAccountRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "CaptainAccountRequest" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "CaptainAccountRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "CaptainAccountRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaptainAccountRequest_status_createdAt_idx"
    ON "CaptainAccountRequest"("status", "createdAt");
CREATE INDEX "CaptainAccountRequest_phone_status_idx"
    ON "CaptainAccountRequest"("phone", "status");
CREATE UNIQUE INDEX "CaptainAccountRequest_one_pending_per_phone_key"
    ON "CaptainAccountRequest"("phone")
    WHERE "status" = 'PENDING';
