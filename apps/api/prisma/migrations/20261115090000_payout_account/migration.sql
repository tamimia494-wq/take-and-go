-- The e-wallet or CliQ number a captain is paid withdrawals to, also kept on each withdrawal request.
ALTER TABLE "Captain" ADD COLUMN "payoutAccount" TEXT;
ALTER TABLE "WithdrawalRequest" ADD COLUMN "payoutAccount" TEXT;
