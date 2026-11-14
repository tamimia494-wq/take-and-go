-- Whether a captain is a producer or a consumer, set by the admin.
CREATE TYPE "CaptainAccountType" AS ENUM ('PRODUCER', 'CONSUMER');

ALTER TABLE "Captain" ADD COLUMN "accountType" "CaptainAccountType";
