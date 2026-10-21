import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { normalizePhone } from "../src/money";

const prisma = new PrismaClient();

async function main() {
  const rawPhone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;
  if (!rawPhone || !password || password === "change-this-before-deploy") {
    throw new Error("Set ADMIN_PHONE and a non-default ADMIN_PASSWORD before seeding.");
  }
  const phone = normalizePhone(rawPhone);

  await prisma.admin.upsert({
    where: { phone },
    update: {},
    create: { phone, passwordHash: await bcrypt.hash(password, 12) }
  });
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
