CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "amountFils" INTEGER NOT NULL,
    "status" "TopUpStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status", "createdAt");

ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "Captain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
