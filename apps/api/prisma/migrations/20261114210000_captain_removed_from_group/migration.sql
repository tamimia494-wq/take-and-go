-- Members the system removed from the WhatsApp group are added back once eligible again.
ALTER TABLE "Captain" ADD COLUMN "removedFromGroupAt" TIMESTAMP(3);
