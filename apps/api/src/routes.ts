import bcrypt from "bcryptjs";
import { LedgerType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { adminLogin, captainLogin, requireAuth } from "./auth";
import { prisma } from "./db";
import { fromFils, toFils } from "./money";
import { importGroupCaptains } from "./whatsapp";

export const router = Router();

router.get("/health", (_req, res) => res.json({ status: "ok" }));
router.post("/auth/captain/login", captainLogin);
router.post("/auth/admin/login", adminLogin);

router.get("/captain/me", requireAuth("captain"), async (req, res) => {
  const captain = await prisma.captain.findUniqueOrThrow({
    where: { id: req.user!.id },
    select: { phone: true, fullName: true, status: true, balanceFils: true }
  });
  res.json({ ...captain, balanceJod: fromFils(captain.balanceFils) });
});

router.post("/captain/activate", requireAuth("captain"), async (req, res) => {
  const parsed = z.object({ fullName: z.string().trim().min(3).max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل الاسم الكامل (3 أحرف على الأقل)." });
    return;
  }
  const captain = await prisma.captain.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (captain.status === "SUSPENDED") {
    res.status(403).json({ error: "الحساب موقوف." });
    return;
  }
  if (captain.status !== "PENDING_PROFILE") {
    res.status(409).json({ error: "تم تفعيل الحساب مسبقاً." });
    return;
  }
  const updated = await prisma.captain.update({
    where: { id: captain.id },
    data: { fullName: parsed.data.fullName, status: "ACTIVE" }
  });
  res.json({ fullName: updated.fullName, status: updated.status });
});

router.get("/captain/dashboard", requireAuth("captain"), async (req, res) => {
  const captainId = req.user!.id;
  const [captain, jobs, ledger] = await Promise.all([
    prisma.captain.findUniqueOrThrow({ where: { id: captainId }, select: { balanceFils: true } }),
    prisma.whatsAppJob.findMany({
      where: { status: "CHARGED", replies: { some: { captainId } } },
      select: { category: true, priceDinars: true }
    }),
    prisma.ledgerEntry.findMany({
      where: { captainId },
      orderBy: { createdAt: "desc" },
      take: 100
    })
  ]);
  res.json({
    balanceJod: fromFils(captain.balanceFils),
    statistics: {
      orders: jobs.filter((job) => job.category === "ORDER").length,
      riders: jobs.filter((job) => job.category === "RIDER").length,
      orderUnits: jobs.filter((job) => job.category === "ORDER").reduce((sum, job) => sum + job.priceDinars / 5, 0),
      riderUnits: jobs.filter((job) => job.category === "RIDER").reduce((sum, job) => sum + job.priceDinars / 5, 0)
    },
    ledger: ledger.map((entry) => ({
      ...entry,
      amountJod: fromFils(entry.amountFils),
      balanceAfterJod: fromFils(entry.balanceAfterFils)
    }))
  });
});

router.get("/admin/dashboard", requireAuth("admin"), async (_req, res) => {
  const [captainCount, activeCaptainCount, aggregate, settings, latest] = await Promise.all([
    prisma.captain.count(),
    prisma.captain.count({ where: { status: "ACTIVE" } }),
    prisma.captain.aggregate({ _sum: { balanceFils: true } }),
    prisma.appSettings.findUniqueOrThrow({ where: { id: "default" } }),
    prisma.ledgerEntry.findMany({
      include: { captain: { select: { fullName: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 8
    })
  ]);
  res.json({
    captainCount,
    activeCaptainCount,
    totalBalanceJod: fromFils(aggregate._sum.balanceFils ?? 0),
    settings: {
      groupFloorJod: fromFils(settings.groupFloorFils),
      riderCommissionPerFiveJod: fromFils(settings.riderCommissionPerFiveFils),
      orderCommissionPerFiveJod: fromFils(settings.orderCommissionPerFiveFils)
    },
    latestActivity: latest.map((entry) => ({
      ...entry,
      amountJod: fromFils(entry.amountFils),
      balanceAfterJod: fromFils(entry.balanceAfterFils)
    }))
  });
});

router.get("/admin/captains", requireAuth("admin"), async (_req, res) => {
  const captains = await prisma.captain.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: { id: true, phone: true, fullName: true, status: true, balanceFils: true, createdAt: true }
  });
  res.json(captains.map((captain) => ({ ...captain, balanceJod: fromFils(captain.balanceFils) })));
});

router.post("/admin/captains/import", requireAuth("admin"), async (_req, res) => {
  try {
    res.json(await importGroupCaptains());
  } catch (error) {
    console.error("Group captain import failed:", error);
    res.status(502).json({
      error: error instanceof Error ? error.message : "تعذر الاتصال بخدمة Green API."
    });
  }
});

router.post("/admin/captains/:id/balance", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    amount: z.union([z.string(), z.number()]),
    description: z.string().trim().min(2).max(160)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل مبلغاً صحيحاً وسبب الشحن." });
    return;
  }
  let amountFils: number;
  try {
    amountFils = toFils(parsed.data.amount);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "المبلغ غير صالح." });
    return;
  }
  if (amountFils <= 0) {
    res.status(400).json({ error: "يجب أن يكون مبلغ الشحن أكبر من صفر." });
    return;
  }
  const captainId = req.params.id;
  if (typeof captainId !== "string") {
    res.status(400).json({ error: "معرّف الكابتن غير صالح." });
    return;
  }
  const result = await prisma.$transaction(async (tx) => {
    const captain = await tx.captain.findUniqueOrThrow({ where: { id: captainId } });
    const updated = await tx.captain.update({
      where: { id: captain.id },
      data: { balanceFils: { increment: amountFils } }
    });
    await tx.ledgerEntry.create({
      data: {
        captainId: captain.id,
        type: LedgerType.CREDIT,
        amountFils,
        balanceAfterFils: updated.balanceFils,
        description: parsed.data.description
      }
    });
    return updated;
  });
  res.json({ balanceJod: fromFils(result.balanceFils) });
});

router.patch("/admin/captains/:id/status", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "حالة الحساب غير صالحة." });
    return;
  }
  const captainId = req.params.id;
  if (typeof captainId !== "string") {
    res.status(400).json({ error: "معرّف الكابتن غير صالح." });
    return;
  }
  const updated = await prisma.captain.update({
    where: { id: captainId },
    data: { status: parsed.data.status }
  });
  res.json({ status: updated.status });
});

router.put("/admin/settings", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    groupFloorJod: z.union([z.string(), z.number()]),
    riderCommissionPerFiveJod: z.union([z.string(), z.number()]),
    orderCommissionPerFiveJod: z.union([z.string(), z.number()])
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل القيم المالية المطلوبة." });
    return;
  }
  try {
    const updated = await prisma.appSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        groupFloorFils: toFils(parsed.data.groupFloorJod),
        riderCommissionPerFiveFils: toFils(parsed.data.riderCommissionPerFiveJod),
        orderCommissionPerFiveFils: toFils(parsed.data.orderCommissionPerFiveJod)
      },
      update: {
        groupFloorFils: toFils(parsed.data.groupFloorJod),
        riderCommissionPerFiveFils: toFils(parsed.data.riderCommissionPerFiveJod),
        orderCommissionPerFiveFils: toFils(parsed.data.orderCommissionPerFiveJod)
      }
    });
    res.json({
      groupFloorJod: fromFils(updated.groupFloorFils),
      riderCommissionPerFiveJod: fromFils(updated.riderCommissionPerFiveFils),
      orderCommissionPerFiveJod: fromFils(updated.orderCommissionPerFiveFils)
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "قيمة مالية غير صالحة." });
  }
});
