import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password === "change-this-before-deploy") {
    throw new Error("Set a non-default ADMIN_PASSWORD before seeding.");
  }

  // The password is normally changed from the admin dashboard, so seeding keeps it.
  // Set ADMIN_PASSWORD_RESET=true for one deploy to force it back to ADMIN_PASSWORD
  // (recovery when the current password is lost), then remove the variable.
  const reset = process.env.ADMIN_PASSWORD_RESET === "true";
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.admin.upsert({
    where: { id: "admin" },
    update: reset ? { passwordHash } : {},
    create: { id: "admin", passwordHash }
  });
  if (reset) console.log("Admin password reset from ADMIN_PASSWORD. Remove ADMIN_PASSWORD_RESET now.");
  await prisma.appSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" }
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
