import "dotenv/config";
import { config as loadRootEnv } from "dotenv";
import path from "node:path";

loadRootEnv({ path: path.resolve(__dirname, "../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// GREEN_API_* names are still read so existing deployments keep working without renaming their variables.
const whatsappGroupId = process.env.WHATSAPP_GROUP_ID || process.env.GREEN_API_GROUP_ID;

export const config = {
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  whatsappGroupId: whatsappGroupId && /^\d+$/.test(whatsappGroupId)
    ? `${whatsappGroupId}@g.us`
    : whatsappGroupId,
  excludedAdminPhones: (process.env.WHATSAPP_EXCLUDED_PHONES || process.env.GREEN_API_EXCLUDED_PHONES || "")
    .split(/[;,\s]+/).filter(Boolean),
  captainAppUrl: process.env.CAPTAIN_APP_URL ?? "http://localhost:3001",
  adminAppUrl: process.env.ADMIN_APP_URL ?? "http://localhost:3002",
  customerAppUrl: process.env.CUSTOMER_APP_URL ?? "http://localhost:3000",
  timezone: process.env.TZ ?? "Asia/Amman",
  adminContactPhone: process.env.ADMIN_CONTACT_PHONE ?? "0797907580"
};
