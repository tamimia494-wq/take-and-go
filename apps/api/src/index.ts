import "dotenv/config";
import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { prisma } from "./db";
import { chargeWeeklyFloor, chargeWeeklyFloorIfDue } from "./accounting";
import { repairCommissions } from "./commission-repair";
import { router } from "./routes";
import { receiveGreenApiWebhook, replayRecentMessages, retryPendingGreenApiWebhooks } from "./whatsapp";

const app = express();
const allowedOrigins = [config.captainAppUrl, config.adminAppUrl];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: false
}));
app.use("/api/captain/topup", express.json({ limit: "6mb" }));
app.use(express.json({ limit: "256kb" }));
app.post("/webhooks/green-api", receiveGreenApiWebhook);
app.use("/api", router);

app.get("/", (_req, res) => res.json({ service: "take-and-go-api", status: "ok" }));

cron.schedule("59 23 * * 4", () => {
  void chargeWeeklyFloor().catch((error: unknown) => {
    console.error("Weekly group-floor deduction failed:", error);
  });
}, { timezone: config.timezone });

// Charges owner-liked replies that were never charged and completes missing commission entries.
let commissionRepairRunning = false;
cron.schedule("*/5 * * * *", () => {
  if (commissionRepairRunning) return;
  commissionRepairRunning = true;
  void repairCommissions()
    .then((result) => {
      if (result.likedCharged.length || result.entriesCreated) {
        console.info(`Commission repair: charged ${result.likedCharged.length} liked replies, added ${result.entriesCreated} missing entries.`);
      }
      if (result.historyError) console.warn("Commission repair could not read group history:", result.historyError);
    })
    .catch((error: unknown) => {
      console.error("Scheduled commission repair failed:", error);
    })
    .finally(() => {
      commissionRepairRunning = false;
    });
});

cron.schedule("* * * * *", () => {
  void retryPendingGreenApiWebhooks().catch((error: unknown) => {
    console.error("Pending Green API webhook retry failed:", error);
  });
});

void chargeWeeklyFloorIfDue().catch((error: unknown) => {
  console.error("Weekly group-floor catch-up failed:", error);
});

const server = app.listen(config.port, () => {
  console.log(`Take & Go API listening on port ${config.port}`);
  // Recover group messages that arrived while the service was restarting.
  setTimeout(() => {
    void replayRecentMessages(20).catch((error: unknown) => {
      console.error("Startup chat history replay failed:", error);
    });
  }, 5_000);
  // Rebuild orders, replies and likes still in the group history that never reached the database, then charge them.
  setTimeout(() => {
    void repairCommissions(1000)
      .then((result) => {
        console.info(
          `Startup commission recovery: ${result.history?.jobsRecorded ?? 0} jobs, ${result.history?.repliesRecorded ?? 0} replies, ` +
          `${result.history?.approvalsRecorded ?? 0} likes recovered; charged ${result.likedCharged.length}, added ${result.entriesCreated} entries.`
        );
        if (result.historyError) console.warn("Startup commission recovery could not read group history:", result.historyError);
      })
      .catch((error: unknown) => {
        console.error("Startup commission recovery failed:", error);
      });
  }, 30_000);
});

async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
