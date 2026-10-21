ALTER TYPE "JobStatus" ADD VALUE 'CANCELED';
ALTER TYPE "ReplyStatus" ADD VALUE 'CANCELED';
ALTER TYPE "JobCategory" ADD VALUE 'MIXED';

ALTER TABLE "WhatsAppJob"
    ADD COLUMN "riderPriceDinars" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "orderPriceDinars" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "riderCommissionFils" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "orderCommissionFils" INTEGER NOT NULL DEFAULT 0;

UPDATE "WhatsAppJob"
SET "riderPriceDinars" = CASE WHEN "category" = 'RIDER' THEN "priceDinars" ELSE 0 END,
    "orderPriceDinars" = CASE WHEN "category" = 'ORDER' THEN "priceDinars" ELSE 0 END,
    "riderCommissionFils" = CASE WHEN "category" = 'RIDER' THEN "commissionFils" ELSE 0 END,
    "orderCommissionFils" = CASE WHEN "category" = 'ORDER' THEN "commissionFils" ELSE 0 END;
