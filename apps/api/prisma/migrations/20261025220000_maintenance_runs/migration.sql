CREATE TABLE "MaintenanceRun" (
    "id" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRun_pkey" PRIMARY KEY ("id")
);
