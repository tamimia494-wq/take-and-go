CREATE TABLE "CaptainAuditLog" (
    "id" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldStatus" TEXT,
    "newStatus" TEXT,
    "fullName" TEXT,
    "details" JSONB,
    "snapshot" JSONB,
    "dbUser" TEXT,
    "applicationName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptainAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaptainAuditLog_phone_createdAt_idx" ON "CaptainAuditLog"("phone", "createdAt");
CREATE INDEX "CaptainAuditLog_captainId_createdAt_idx" ON "CaptainAuditLog"("captainId", "createdAt");

-- Records account changes whoever makes them: the app, a script or a direct database edit.
CREATE OR REPLACE FUNCTION captain_audit_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "CaptainAuditLog" ("id", "captainId", "phone", "action", "newStatus", "fullName", "snapshot", "dbUser", "applicationName")
    VALUES (gen_random_uuid()::text, NEW."id", NEW."phone", 'CREATED', NEW."status"::text, NEW."fullName",
            to_jsonb(NEW) - 'passwordHash', current_user, current_setting('application_name', true));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."phone" IS DISTINCT FROM OLD."phone"
       OR NEW."fullName" IS DISTINCT FROM OLD."fullName" OR NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" THEN
      INSERT INTO "CaptainAuditLog" ("id", "captainId", "phone", "action", "oldStatus", "newStatus", "fullName", "details", "dbUser", "applicationName")
      VALUES (gen_random_uuid()::text, NEW."id", NEW."phone", 'UPDATED', OLD."status"::text, NEW."status"::text, NEW."fullName",
              jsonb_build_object(
                'oldPhone', OLD."phone",
                'oldFullName', OLD."fullName",
                'passwordChanged', NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash"
              ),
              current_user, current_setting('application_name', true));
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO "CaptainAuditLog" ("id", "captainId", "phone", "action", "oldStatus", "fullName", "snapshot", "dbUser", "applicationName")
    VALUES (gen_random_uuid()::text, OLD."id", OLD."phone", 'DELETED', OLD."status"::text, OLD."fullName",
            to_jsonb(OLD) - 'passwordHash', current_user, current_setting('application_name', true));
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captain_audit_log
AFTER INSERT OR UPDATE OR DELETE ON "Captain"
FOR EACH ROW EXECUTE FUNCTION captain_audit_log();

-- A deleted ledger entry is kept in full, so an account's history survives even if its rows are removed.
CREATE OR REPLACE FUNCTION ledger_entry_deletion_log() RETURNS trigger AS $$
BEGIN
  INSERT INTO "CaptainAuditLog" ("id", "captainId", "phone", "action", "snapshot", "dbUser", "applicationName")
  VALUES (gen_random_uuid()::text, OLD."captainId",
          COALESCE((SELECT "phone" FROM "Captain" WHERE "id" = OLD."captainId"), ''),
          'LEDGER_ENTRY_DELETED', to_jsonb(OLD), current_user, current_setting('application_name', true));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_deletion_log
AFTER DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION ledger_entry_deletion_log();
