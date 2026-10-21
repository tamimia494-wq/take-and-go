import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password === "change-this-before-deploy") {
    throw new Error("Set a non-default ADMIN_PASSWORD before seeding.");
  }

  await prisma.admin.upsert({
    where: { id: "admin" },
    update: { passwordHash: await bcrypt.hash(password, 12) },
    create: { id: "admin", passwordHash: await bcrypt.hash(password, 12) }
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
