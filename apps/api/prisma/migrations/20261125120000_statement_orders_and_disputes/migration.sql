ALTER TABLE "WhatsAppJob" ADD COLUMN "sourceText" TEXT;

-- Orders still in the 3-day message store get their text now; newer orders store it when they are recorded.
UPDATE "WhatsAppJob" AS job
SET "sourceText" = message."record"->>'textMessage'
FROM "WhatsAppMessage" AS message
WHERE message."id" = job."sourceMessageId" AND job."sourceText" IS NULL AND message."record"->>'textMessage' IS NOT NULL;

CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED');

CREATE TABLE "StatementDispute" (
    "id" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "StatementDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StatementDispute_captainId_jobId_key" ON "StatementDispute"("captainId", "jobId");
CREATE INDEX "StatementDispute_status_createdAt_idx" ON "StatementDispute"("status", "createdAt");

ALTER TABLE "StatementDispute" ADD CONSTRAINT "StatementDispute_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "Captain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StatementDispute" ADD CONSTRAINT "StatementDispute_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "WhatsAppJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
