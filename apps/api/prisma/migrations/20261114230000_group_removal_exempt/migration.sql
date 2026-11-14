-- Captains exempted from automatic removal from the WhatsApp group.
ALTER TABLE "Captain" ADD COLUMN "groupRemovalExempt" BOOLEAN NOT NULL DEFAULT false;
