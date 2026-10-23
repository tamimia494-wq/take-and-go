import "dotenv/config";
import { config as loadRootEnv } from "dotenv";
import path from "node:path";

loadRootEnv({ path: path.resolve(__dirname, "../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const greenApiGroupId = process.env.GREEN_API_GROUP_ID;

export const config = {
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  webhookToken: process.env.GREEN_API_WEBHOOK_TOKEN || undefined,
  greenApiUrl: (process.env.GREEN_API_URL ?? "https://api.green-api.com").replace(/\/$/, ""),
  greenApiInstanceId: process.env.GREEN_API_INSTANCE_ID || undefined,
  greenApiToken: process.env.GREEN_API_TOKEN || undefined,
  greenApiGroupId: greenApiGroupId && /^\d+$/.test(greenApiGroupId)
    ? `${greenApiGroupId}@g.us`
    : greenApiGroupId,
  excludedAdminPhones: (process.env.GREEN_API_EXCLUDED_PHONES ?? "").split(/[;,\s]+/).filter(Boolean),
  captainAppUrl: process.env.CAPTAIN_APP_URL ?? "http://localhost:3001",
  adminAppUrl: process.env.ADMIN_APP_URL ?? "http://localhost:3002",
  timezone: process.env.TZ ?? "Asia/Amman"
};
