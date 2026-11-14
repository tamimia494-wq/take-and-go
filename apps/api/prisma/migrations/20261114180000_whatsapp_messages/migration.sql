-- Group messages seen by the direct WhatsApp link replace Green API's chat history.
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "participant" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "record" JSONB NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppMessage_timestamp_idx" ON "WhatsAppMessage"("timestamp");
