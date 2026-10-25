import "dotenv/config";
import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { prisma } from "./db";
import { chargeWeeklyFloor, chargeWeeklyFloorIfDue } from "./accounting";
import { router } from "./routes";
import { receiveGreenApiWebhook, replayRecentMessages } from "./whatsapp";

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
});

async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
