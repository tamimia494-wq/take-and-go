import bcrypt from "bcryptjs";
import { LedgerType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { adminLogin, captainLogin, requireAuth } from "./auth";
import { prisma } from "./db";
import { fromFils, normalizePhone, toFils } from "./money";
import { importGroupCaptains } from "./whatsapp";
import { greenApiRequest } from "./green-api";
import { config } from "./config";

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
  const updated = await prisma.$transaction(async (tx) => {
    const activated = await tx.captain.updateMany({
      where: { id: captain.id, status: "PENDING_PROFILE" },
      data: {
        fullName: parsed.data.fullName,
        status: "ACTIVE"
      }
    });
    if (activated.count !== 1) return null;

    const idempotencyKey = `activation-bonus:${captain.id}`;
    const existingBonus = await tx.ledgerEntry.findUnique({ where: { idempotencyKey } });
    if (!existingBonus) {
      const account = await tx.captain.update({
        where: { id: captain.id },
        data: { balanceFils: { increment: 1000 } }
      });
      await tx.ledgerEntry.create({
        data: {
          captainId: account.id,
          type: LedgerType.CREDIT,
          amountFils: 1000,
          balanceAfterFils: account.balanceFils,
          description: "مكافأة تفعيل الحساب لأول مرة",
          idempotencyKey
        }
      });
      return account;
    }

    return tx.captain.findUniqueOrThrow({ where: { id: captain.id } });
  });
  if (!updated) {
    res.status(409).json({ error: "تم تفعيل الحساب مسبقًا." });
    return;
  }
  res.json({
    fullName: updated.fullName,
    status: updated.status,
    balanceJod: fromFils(updated.balanceFils)
  });
});

router.get("/captain/dashboard", requireAuth("captain"), async (req, res) => {
  const captainId = req.user!.id;
  const [captain, jobs, ledger] = await Promise.all([
    prisma.captain.findUniqueOrThrow({ where: { id: captainId }, select: { balanceFils: true } }),
    prisma.whatsAppJob.findMany({
      where: { status: "CHARGED", replies: { some: { captainId } } },
      select: { riderPriceDinars: true, orderPriceDinars: true }
    }),
    prisma.ledgerEntry.findMany({
      where: { captainId },
      orderBy: { createdAt: "desc" },
      take: 100
    })
  ]);
  const orderUnits = jobs.reduce((sum, job) => sum + Math.round(job.orderPriceDinars / 5), 0);
  const riderUnits = jobs.reduce((sum, job) => sum + Math.round(job.riderPriceDinars / 5), 0);
  res.json({
    balanceJod: fromFils(captain.balanceFils),
    statistics: {
      orders: orderUnits,
      riders: riderUnits,
      orderUnits,
      riderUnits
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

router.post("/admin/captains/initial-credit", requireAuth("admin"), async (_req, res) => {
  const credited = await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id
      FROM "Captain" c
      WHERE NOT EXISTS (
        SELECT 1
        FROM "LedgerEntry" l
        WHERE l."captainId" = c.id
          AND l."idempotencyKey" = 'activation-bonus:' || c.id
      )
      FOR UPDATE
    `;

    let count = 0;
    for (const candidate of candidates) {
      const idempotencyKey = `activation-bonus:${candidate.id}`;
      const existingBonus = await tx.ledgerEntry.findUnique({ where: { idempotencyKey } });
      if (existingBonus) continue;

      const captain = await tx.captain.update({
        where: { id: candidate.id },
        data: { balanceFils: { increment: 1000 } }
      });
      await tx.ledgerEntry.create({
        data: {
          captainId: captain.id,
          type: LedgerType.CREDIT,
          amountFils: 1000,
          balanceAfterFils: captain.balanceFils,
          description: "رصيد تفعيل أولي لمرة واحدة",
          idempotencyKey
        }
      });
      count += 1;
    }

    return count;
  }, { timeout: 60_000 });

  res.json({ creditedAccounts: credited, amountJodPerAccount: 1 });
});

router.get("/admin/green-api/diagnose", requireAuth("admin"), async (_req, res) => {
  const configured = Boolean(config.greenApiInstanceId && config.greenApiToken && config.greenApiGroupId);
  const result: Record<string, unknown> = {
    configured,
    instanceId: config.greenApiInstanceId ?? null,
    groupId: config.greenApiGroupId ?? null
  };
  if (!configured) {
    res.status(400).json({ error: "متغيرات Green API غير مضبوطة على الخادم (Instance ID / Token / Group ID).", ...result });
    return;
  }
  try {
    const settings = await greenApiRequest<{ stateInstance?: string; phone?: string; errorMessage?: string }>("getWaSettings");
    result.instanceState = settings.stateInstance ?? settings.errorMessage ?? "unknown";
    result.instancePhone = settings.phone ?? null;
    result.authorized = settings.stateInstance === "authorized";
  } catch (error) {
    result.instanceError = error instanceof Error ? error.message : String(error);
  }
  try {
    const data = await greenApiRequest<{ participants?: unknown[] }>("getGroupData", { groupId: config.greenApiGroupId });
    result.groupFound = true;
    result.participantCount = (data.participants ?? []).length;
  } catch (error) {
    result.groupError = error instanceof Error ? error.message : String(error);
  }
  res.json(result);
});

router.post("/admin/captains/import", requireAuth("admin"), async (req, res) => {
  try {
    const result = await importGroupCaptains();
    res.json(result);
  } catch (error) {
    console.error("Group captain import failed:", error);
    res.status(502).json({
      error: error instanceof Error ? error.message : "تعذر الاتصال بخدمة Green API."
    });
  }
});

router.post("/admin/captains/:id/balance", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    amount: z.union([z.string(), z.number()])
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل مبلغاً صحيحاً." });
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
        description: "شحن رصيد"
      }
    });
    return updated;
  });
  res.json({ balanceJod: fromFils(result.balanceFils) });
});

router.post("/admin/captains/adjust", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    phone: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    action: z.enum(["credit", "debit"]).default("credit")
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم الهاتف والمبلغ." });
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
    res.status(400).json({ error: "يجب أن يكون المبلغ أكبر من صفر." });
    return;
  }
  let phone: string;
  try {
    phone = normalizePhone(String(parsed.data.phone));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }
  const credit = parsed.data.action !== "debit";
  try {
    const result = await prisma.$transaction(async (tx) => {
      const captain = await tx.captain.findUnique({ where: { phone } });
      if (!captain) throw new Error("لا يوجد كابتن بهذا الرقم.");
      if (!credit && captain.balanceFils < amountFils) {
        throw new Error(`الرصيد غير كافٍ. الرصيد الحالي: ${fromFils(captain.balanceFils)} د.أ.`);
      }
      const updated = await tx.captain.update({
        where: { id: captain.id },
        data: { balanceFils: credit ? { increment: amountFils } : { decrement: amountFils } }
      });
      await tx.ledgerEntry.create({
        data: {
          captainId: captain.id,
          type: credit ? LedgerType.CREDIT : LedgerType.ADJUSTMENT,
          amountFils,
          balanceAfterFils: updated.balanceFils,
          description: credit ? "شحن رصيد" : "خصم رصيد"
        }
      });
      return { captain, updated };
    });
    res.json({
      fullName: result.captain.fullName,
      phone: result.captain.phone,
      balanceJod: fromFils(result.updated.balanceFils)
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر تنفيذ العملية." });
  }
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

// ==== طلبات شحن الرصيد ====
router.post("/captain/topup", requireAuth("captain"), async (req, res) => {
  const parsed = z.object({
    amount: z.union([z.string(), z.number()]),
    receipt: z.string().min(1).max(5_592_500)
  }).safeParse(req.body);
  if (!parsed.success) {
    const hasReceiptError = parsed.error.issues.some((issue) => issue.path[0] === "receipt");
    res.status(400).json({ error: hasReceiptError ? "أرفق صورة وصل التحويل لإتمام الطلب." : "أدخل مبلغ الشحن." });
    return;
  }
  const receiptMatch = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(parsed.data.receipt);
  if (!receiptMatch) {
    res.status(400).json({ error: "أرفق صورة وصل صالحة بصيغة JPG أو PNG أو WebP أو GIF." });
    return;
  }
  const receiptMimeType = receiptMatch[1];
  const receiptData = Buffer.from(receiptMatch[2], "base64");
  if (
    receiptData.length === 0 ||
    receiptData.length > 4 * 1024 * 1024 ||
    receiptData.toString("base64") !== receiptMatch[2] ||
    !isSupportedReceiptImage(receiptMimeType, receiptData)
  ) {
    res.status(400).json({ error: "صورة الوصل غير صالحة أو يتجاوز حجمها 4 ميغابايت." });
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
  const created = await prisma.topUpRequest.create({
    data: { captainId: req.user!.id, amountFils, receiptData, receiptMimeType }
  });
  res.json({
    id: created.id,
    amountJod: fromFils(amountFils)
  });
});

router.get("/admin/topups", requireAuth("admin"), async (_req, res) => {
  const requests = await prisma.topUpRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      amountFils: true,
      receiptMimeType: true,
      status: true,
      createdAt: true,
      captain: { select: { fullName: true, phone: true } }
    }
  });
  res.json(requests.map((request) => ({
    id: request.id,
    captainName: request.captain.fullName ?? request.captain.phone,
    captainPhone: request.captain.phone,
    amountJod: fromFils(request.amountFils),
    hasReceipt: request.receiptMimeType !== null,
    status: request.status,
    createdAt: request.createdAt
  })));
});

router.get("/admin/topups/:id/receipt", requireAuth("admin"), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;
  if (!id) {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  const request = await prisma.topUpRequest.findUnique({
    where: { id },
    select: { receiptData: true, receiptMimeType: true }
  });
  if (!request?.receiptData || !request.receiptMimeType) {
    res.status(404).json({ error: "صورة وصل الشحن غير موجودة." });
    return;
  }
  res.type(request.receiptMimeType).send(request.receiptData);
});

router.post("/admin/topups/:id/approve", requireAuth("admin"), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;
  if (!id) {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.topUpRequest.findUnique({ where: { id }, include: { captain: true } });
      if (!request) throw new Error("طلب الشحن غير موجود.");
      if (request.status !== "PENDING") throw new Error("تمت معالجة الطلب مسبقاً.");
      if (!request.receiptData || !request.receiptMimeType) throw new Error("لا يمكن اعتماد طلب شحن بدون صورة وصل.");
      const claimed = await tx.topUpRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "APPROVED", reviewedAt: new Date() }
      });
      if (claimed.count !== 1) throw new Error("تمت معالجة الطلب مسبقاً.");
      const updated = await tx.captain.update({
        where: { id: request.captainId },
        data: { balanceFils: { increment: request.amountFils } }
      });
      await tx.ledgerEntry.create({
        data: {
          captainId: request.captainId,
          type: LedgerType.CREDIT,
          amountFils: request.amountFils,
          balanceAfterFils: updated.balanceFils,
          description: `شحن رصيد عبر طلب داخل التطبيق`,
          reference: request.id,
          idempotencyKey: `topup:${request.id}`
        }
      });
      return updated;
    });
    res.json({ balanceJod: fromFils(result.balanceFils) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر اعتماد الطلب." });
  }
});

router.post("/admin/topups/:id/reject", requireAuth("admin"), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;
  if (!id) {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  try {
    const deleted = await prisma.topUpRequest.deleteMany({
      where: { id, status: "PENDING" }
    });
    if (deleted.count !== 1) {
      res.status(400).json({ error: "تمت معالجة الطلب مسبقاً أو غير موجود." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر رفض الطلب." });
  }
});

// ==== طرق الدفع ====
router.get("/payment-methods", async (_req, res) => {
  const methods = await prisma.paymentMethod.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  res.json(methods.map((m) => ({ id: m.id, label: m.label, details: m.details })));
});

router.post("/admin/payment-methods", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    label: z.string().trim().min(2).max(60),
    details: z.string().trim().min(3).max(120)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل اسم البنك/المحفظة ورقم الحساب." });
    return;
  }
  const count = await prisma.paymentMethod.count();
  const created = await prisma.paymentMethod.create({
    data: { label: parsed.data.label, details: parsed.data.details, sortOrder: count }
  });
  res.json({ id: created.id, label: created.label, details: created.details });
});

router.delete("/admin/payment-methods/:id", requireAuth("admin"), async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  const result = await prisma.paymentMethod.deleteMany({ where: { id } });
  if (result.count === 0) {
    res.status(404).json({ error: "طريقة الدفع غير موجودة." });
    return;
  }
  res.json({ ok: true });
});

function isSupportedReceiptImage(mimeType: string, data: Buffer): boolean {
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === "image/png") return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/gif") return data.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/) !== null;
  return mimeType === "image/webp" &&
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP";
}

router.post("/admin/password", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(6).max(128)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل." });
    return;
  }
  const admin = await prisma.admin.findUnique({ where: { id: "admin" } });
  if (!admin || !(await bcrypt.compare(parsed.data.currentPassword, admin.passwordHash))) {
    res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة." });
    return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.admin.update({ where: { id: "admin" }, data: { passwordHash } });
  res.json({ ok: true });
});
