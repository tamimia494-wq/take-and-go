-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CaptainStatus" AS ENUM ('PENDING_PROFILE', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CREDIT', 'ORDER_COMMISSION', 'RIDER_COMMISSION', 'GROUP_FLOOR', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "JobCategory" AS ENUM ('ORDER', 'RIDER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'CHARGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReplyStatus" AS ENUM ('PENDING', 'PROCESSING', 'CHARGED', 'REJECTED');

-- CreateTable
CREATE TABLE "Captain" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT,
    "status" "CaptainStatus" NOT NULL DEFAULT 'PENDING_PROFILE',
    "balanceFils" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Captain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "groupFloorFils" INTEGER NOT NULL DEFAULT 0,
    "riderCommissionPerFiveFils" INTEGER NOT NULL DEFAULT 750,
    "orderCommissionPerFiveFils" INTEGER NOT NULL DEFAULT 1000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountFils" INTEGER NOT NULL,
    "balanceAfterFils" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppJob" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceSenderPhone" TEXT,
    "priceDinars" INTEGER NOT NULL,
    "category" "JobCategory" NOT NULL,
    "commissionFils" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppReply" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "captainId" TEXT,
    "body" TEXT NOT NULL,
    "status" "ReplyStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyFloorCharge" (
    "id" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyFloorCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Captain_phone_key" ON "Captain"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_phone_key" ON "Admin"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_captainId_createdAt_idx" ON "LedgerEntry"("captainId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppJob_status_createdAt_idx" ON "WhatsAppJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppJob_groupId_sourceMessageId_key" ON "WhatsAppJob"("groupId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppReply_messageId_key" ON "WhatsAppReply"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyFloorCharge_weekKey_key" ON "WeeklyFloorCharge"("weekKey");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "Captain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppReply" ADD CONSTRAINT "WhatsAppReply_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "WhatsAppJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppReply" ADD CONSTRAINT "WhatsAppReply_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "Captain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
