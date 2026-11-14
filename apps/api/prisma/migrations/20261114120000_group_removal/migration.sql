-- Removing ineligible members from the WhatsApp group stays off until an admin turns it on.
ALTER TABLE "AppSettings" ADD COLUMN "groupRemovalEnabled" BOOLEAN NOT NULL DEFAULT false;
