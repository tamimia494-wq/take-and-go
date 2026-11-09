import bcrypt from "bcryptjs";
import { LedgerType, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { adminLogin, captainLogin, customerLogin, customerRegister, requireAuth } from "./auth";
import { repairCommissions, runCommissionAudit } from "./commission-repair";
import { prisma } from "./db";
import { commissionUnits } from "./pricing";
import { buildStatement, statementPeriod, sumStatements, type StatementEntry } from "./statement";
import { fromFils, MINIMUM_CAPTAIN_REPLY_BALANCE_FILS, normalizePhone, phoneFromChatId, toFils } from "./money";
import { getDeletionStatus, importGroupCaptains, isExcludedPhone } from "./whatsapp";
import { getSocketState, logoutWhatsAppSocket, startWhatsAppSocket } from "./whatsapp-socket";
import QRCode from "qrcode";
import { getLastDeletionStatus, greenApiRequest } from "./green-api";
import { config } from "./config";

export const router = Router();

router.get("/health", (_req, res) => res.json({ status: "ok" }));
router.post("/auth/captain/login", captainLogin);
router.post("/auth/admin/login", adminLogin);
router.post("/auth/customer/login", customerLogin);
router.post("/auth/customer/register", customerRegister);

router.post("/captain/account-requests", async (req, res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(3).max(100),
    phone: z.string().min(8).max(24)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل الاسم الكامل ورقم هاتف صحيحاً." });
    return;
  }

  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }

  try {
    const request = await prisma.$transaction(async (tx) => {
      if (await tx.captain.findUnique({ where: { phone }, select: { id: true } })) {
        throw new Error("يوجد حساب مسجل بهذا الرقم بالفعل.");
      }
      if (await tx.captainAccountRequest.findFirst({
        where: { phone, status: "PENDING" },
        select: { id: true }
      })) {
        throw new Error("لديك طلب إنشاء حساب قيد المراجعة بالفعل.");
      }
      return tx.captainAccountRequest.create({
        data: { fullName: parsed.data.fullName, phone }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.status(201).json({ id: request.id, status: request.status });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "لديك طلب إنشاء حساب قيد المراجعة بالفعل." });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      res.status(409).json({ error: "تغيّرت حالة الطلب بالتزامن. تحقق من حالة الحساب ثم أعد المحاولة." });
      return;
    }
    if (error instanceof Error && error.message === "يوجد حساب مسجل بهذا الرقم بالفعل.") {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message === "لديك طلب إنشاء حساب قيد المراجعة بالفعل.") {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

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

router.post("/captain/password", requireAuth("captain"), async (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(6).max(128)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل." });
    return;
  }
  const captain = await prisma.captain.findUnique({ where: { id: req.user!.id } });
  if (!captain || !(await bcrypt.compare(parsed.data.currentPassword, captain.passwordHash))) {
    res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة." });
    return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.captain.update({ where: { id: captain.id }, data: { passwordHash } });
  res.json({ ok: true });
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
  const orderUnits = jobs.reduce((sum, job) => sum + commissionUnits(job.orderPriceDinars), 0);
  const riderUnits = jobs.reduce((sum, job) => sum + commissionUnits(job.riderPriceDinars), 0);
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
    // Every ledger movement of the last 24 hours, capped so a very busy day cannot bloat the dashboard.
    prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      include: { captain: { select: { fullName: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 1000
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

router.get("/admin/whatsapp-jobs/:id", requireAuth("admin"), async (req, res) => {
  const jobId = req.params.id;
  if (typeof jobId !== "string") {
    res.status(400).json({ error: "معرّف الطلب غير صالح." });
    return;
  }

  const job = await prisma.whatsAppJob.findFirst({
    where: { OR: [{ id: jobId }, { sourceMessageId: jobId }] },
    include: {
      replies: {
        select: { messageId: true, senderPhone: true, status: true, createdAt: true }
      }
    }
  });

  if (!job) {
    res.status(404).json({ error: "الطلب غير موجود." });
    return;
  }

  const ledger = await prisma.ledgerEntry.findMany({
    where: { reference: job.id },
    select: {
      type: true,
      amountFils: true,
      description: true,
      createdAt: true,
      captain: { select: { fullName: true, phone: true } }
    },
    orderBy: { createdAt: "asc" }
  });

  res.json({
    job: {
      id: job.id,
      sourceMessageId: job.sourceMessageId,
      sourceSenderPhone: job.sourceSenderPhone,
      priceDinars: job.priceDinars,
      riderPriceDinars: job.riderPriceDinars,
      orderPriceDinars: job.orderPriceDinars,
      category: job.category,
      commissionFils: job.commissionFils,
      riderCommissionFils: job.riderCommissionFils,
      orderCommissionFils: job.orderCommissionFils,
      status: job.status,
      createdAt: job.createdAt,
      replies: job.replies
    },
    ledger: ledger.map((entry) => ({
      ...entry,
      amountJod: fromFils(entry.amountFils)
    }))
  });
});

router.get("/admin/whatsapp-jobs-search", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    ownerPhone: z.string().min(8).max(24),
    captainPhone: z.string().min(8).max(24).optional(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true })
  }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقمي صاحب الطلب والكابتن وفترة زمنية صحيحة." });
    return;
  }

  let ownerPhone: string;
  let captainPhone: string | undefined;
  try {
    ownerPhone = normalizePhone(parsed.data.ownerPhone);
    captainPhone = parsed.data.captainPhone ? normalizePhone(parsed.data.captainPhone) : undefined;
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }

  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (from >= to || to.getTime() - from.getTime() > 60 * 60 * 1000) {
    res.status(400).json({ error: "يجب أن تكون الفترة موجبة ولا تتجاوز ساعة واحدة." });
    return;
  }

  const jobs = await prisma.whatsAppJob.findMany({
    where: {
      sourceSenderPhone: ownerPhone,
      createdAt: { gte: from, lte: to },
      ...(captainPhone ? { replies: { some: { senderPhone: captainPhone } } } : {})
    },
    take: 20,
    orderBy: { createdAt: "asc" },
    include: {
      replies: {
        ...(captainPhone ? { where: { senderPhone: captainPhone } } : {}),
        select: { messageId: true, senderPhone: true, status: true, createdAt: true }
      }
    }
  });
  const ledger = jobs.length
    ? await prisma.ledgerEntry.findMany({
      where: { reference: { in: jobs.map((job) => job.id) } },
      select: {
        reference: true,
        type: true,
        amountFils: true,
        description: true,
        createdAt: true,
        captain: { select: { phone: true } }
      },
      orderBy: { createdAt: "asc" }
    })
    : [];

  res.json({
    count: jobs.length,
    jobs: jobs.map((job) => ({
      id: job.id,
      sourceMessageId: job.sourceMessageId,
      sourceSenderPhone: job.sourceSenderPhone,
      priceDinars: job.priceDinars,
      riderPriceDinars: job.riderPriceDinars,
      orderPriceDinars: job.orderPriceDinars,
      commissionFils: job.commissionFils,
      riderCommissionFils: job.riderCommissionFils,
      orderCommissionFils: job.orderCommissionFils,
      status: job.status,
      createdAt: job.createdAt,
      replies: job.replies
    })),
    ledger: ledger.map((entry) => ({
      ...entry,
      amountJod: fromFils(entry.amountFils)
    }))
  });
});

router.get("/admin/commission-audit", requireAuth("admin"), async (_req, res) => {
  res.json(await runCommissionAudit(prisma));
});

router.post("/admin/commission-audit/repair", requireAuth("admin"), async (_req, res) => {
  res.json(await repairCommissions(1000));
});

/** Everything known about a phone number: its account, the account change log, requests and ledger activity. */
router.get("/admin/phone-lookup", requireAuth("admin"), async (req, res) => {
  let phone: string;
  try {
    phone = normalizePhone(String(req.query.phone ?? ""));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }
  const captain = await prisma.captain.findUnique({
    where: { phone },
    select: { id: true, fullName: true, status: true, balanceFils: true, createdAt: true, updatedAt: true }
  });
  const [auditLog, accountRequests, ledgerCount, firstEntry, latestEntries, repliesCount, ordersPosted] = await Promise.all([
    prisma.captainAuditLog.findMany({
      where: { OR: [{ phone }, ...(captain ? [{ captainId: captain.id }] : [])] },
      orderBy: { createdAt: "desc" },
      take: 200
    }),
    prisma.captainAccountRequest.findMany({ where: { phone }, orderBy: { createdAt: "desc" }, take: 20 }),
    captain ? prisma.ledgerEntry.count({ where: { captainId: captain.id } }) : Promise.resolve(0),
    captain ? prisma.ledgerEntry.findFirst({ where: { captainId: captain.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve(null),
    captain
      ? prisma.ledgerEntry.findMany({ where: { captainId: captain.id }, orderBy: { createdAt: "desc" }, take: 30 })
      : Promise.resolve([]),
    captain ? prisma.whatsAppReply.count({ where: { captainId: captain.id } }) : Promise.resolve(0),
    prisma.whatsAppJob.count({ where: { sourceSenderPhone: phone } })
  ]);
  res.json({
    phone,
    captain: captain ? { ...captain, balanceJod: fromFils(captain.balanceFils) } : null,
    auditLog,
    accountRequests,
    ledger: {
      count: ledgerCount,
      firstAt: firstEntry?.createdAt ?? null,
      latest: latestEntries.map((entry) => ({ ...entry, amountJod: fromFils(entry.amountFils), balanceAfterJod: fromFils(entry.balanceAfterFils) }))
    },
    repliesCount,
    ordersPosted
  });
});

router.get("/admin/captains", requireAuth("admin"), async (_req, res) => {
  const captains = await prisma.captain.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: { id: true, phone: true, fullName: true, status: true, balanceFils: true, createdAt: true }
  });
  res.json(captains.map((captain) => ({ ...captain, balanceJod: fromFils(captain.balanceFils) })));
});

router.post("/admin/captains", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(3).max(100),
    phone: z.string().min(8).max(24)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل الاسم الكامل ورقم هاتف صحيحاً." });
    return;
  }
  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash("123456", 12);
    const captain = await prisma.$transaction(async (tx) => {
      if (await tx.captainAccountRequest.findFirst({
        where: { phone, status: "PENDING" },
        select: { id: true }
      })) {
        throw new Error("لدى هذا الرقم طلب إنشاء حساب معلق؛ راجعه من قائمة الطلبات.");
      }
      return tx.captain.create({
        data: {
          fullName: parsed.data.fullName,
          phone,
          passwordHash,
          status: "ACTIVE"
        },
        select: { id: true, fullName: true, phone: true, status: true }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.status(201).json(captain);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "يوجد حساب مسجل بهذا الرقم بالفعل." });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      res.status(409).json({ error: "تغيّرت حالة الطلب بالتزامن. تحقق من الطلبات ثم أعد المحاولة." });
      return;
    }
    if (error instanceof Error && error.message === "لدى هذا الرقم طلب إنشاء حساب معلق؛ راجعه من قائمة الطلبات.") {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/admin/captain-account-requests", requireAuth("admin"), async (_req, res) => {
  const requests = await prisma.captainAccountRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" }
  });
  res.json(requests);
});

router.post("/admin/captain-account-requests/:id/review", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({ action: z.enum(["approve", "reject"]) }).safeParse(req.body);
  const requestId = req.params.id;
  if (!parsed.success || typeof requestId !== "string") {
    res.status(400).json({ error: "طلب المراجعة غير صالح." });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.captainAccountRequest.findUniqueOrThrow({ where: { id: requestId } });
      if (request.status !== "PENDING") throw new Error("تمت مراجعة هذا الطلب مسبقاً.");
      const updated = await tx.captainAccountRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: parsed.data.action === "approve" ? "APPROVED" : "REJECTED",
          reviewedAt: new Date()
        }
      });
      if (updated.count !== 1) throw new Error("تمت مراجعة هذا الطلب مسبقاً.");
      if (parsed.data.action === "reject") return { status: "REJECTED" as const };

      const captain = await tx.captain.create({
        data: {
          fullName: request.fullName,
          phone: request.phone,
          passwordHash: await bcrypt.hash("123456", 12),
          status: "ACTIVE"
        },
        select: { id: true, fullName: true, phone: true, status: true }
      });
      return { status: "APPROVED" as const, captain };
    });
    res.json(result);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "يوجد حساب مسجل بهذا الرقم بالفعل؛ لم يتم اعتماد الطلب." });
      return;
    }
    if (error instanceof Error && error.message === "تمت مراجعة هذا الطلب مسبقاً.") {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
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

router.get("/admin/green-api/diagnose", requireAuth("admin"), async (req, res) => {
  const configured = Boolean(config.greenApiInstanceId && config.greenApiToken && config.greenApiGroupId);
  const result: Record<string, unknown> = {
    configured,
    instanceId: config.greenApiInstanceId ?? null,
    groupId: config.greenApiGroupId ?? null
  };
  try {
    const settings = await greenApiRequest<{ stateInstance?: string; phone?: string; errorMessage?: string }>("getWaSettings");
    result.instanceState = settings.stateInstance ?? settings.errorMessage ?? "unknown";
    result.instancePhone = settings.phone ?? null;
    result.authorized = settings.stateInstance === "authorized";
  } catch (error) {
    result.instanceError = error instanceof Error ? error.message : String(error);
  }
  try {
    const data = await greenApiRequest<{
      participants?: Array<{ id?: string; participantId?: string; phoneNumber?: string; isAdmin?: boolean; isSuperAdmin?: boolean }>;
    }>("getGroupData", { groupId: config.greenApiGroupId });
    result.groupFound = true;
    result.participantCount = (data.participants ?? []).length;
    // Deleting other members' messages requires the bot to be a group admin.
    const botPhone = typeof result.instancePhone === "string" ? phoneFromChatId(result.instancePhone) : null;
    const bot = botPhone
      ? (data.participants ?? []).find((participant) =>
        [participant.phoneNumber, participant.id, participant.participantId].some((id) => id && phoneFromChatId(id) === botPhone))
      : undefined;
    result.botInGroup = Boolean(bot);
    result.botIsAdmin = Boolean(bot && (bot.isAdmin || bot.isSuperAdmin));
  } catch (error) {
    result.groupError = error instanceof Error ? error.message : String(error);
  }
  try {
    const settings = await greenApiRequest<{ webhookUrl?: string; incomingWebhook?: string }>("getSettings");
    result.webhookUrl = settings.webhookUrl ?? null;
    result.incomingWebhook = settings.incomingWebhook ?? null;
  } catch (error) {
    result.settingsError = error instanceof Error ? error.message : String(error);
  }
  result.excludedPhones = [config.adminContactPhone, ...config.excludedAdminPhones]
    .map((phone) => phoneFromChatId(phone) ?? phone);
  const [queue, latestErrors] = await Promise.all([
    prisma.whatsAppWebhookEvent.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.whatsAppWebhookEvent.findMany({
      where: { lastError: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { status: true, attempts: true, lastError: true, updatedAt: true }
    })
  ]);
  result.webhookQueue = Object.fromEntries(queue.map((row) => [row.status, row._count._all]));
  result.latestWebhookErrors = latestErrors;
  Object.assign(result, getDeletionStatus());
  result.socket = getSocketState().status;
  result.lastDeletion = getLastDeletionStatus();

  const phoneQuery = typeof req.query.phone === "string" ? req.query.phone : "";
  if (phoneQuery) {
    try {
      const phone = normalizePhone(phoneQuery);
      const captain = await prisma.captain.findUnique({
        where: { phone },
        select: { status: true, balanceFils: true }
      });
      result.phoneCheck = {
        phone,
        excluded: isExcludedPhone(phone),
        hasAccount: Boolean(captain),
        status: captain?.status ?? null,
        balanceJod: captain ? fromFils(captain.balanceFils) : null,
        shouldDelete: !isExcludedPhone(phone) && (!captain || captain.status !== "ACTIVE" ||
          captain.balanceFils < MINIMUM_CAPTAIN_REPLY_BALANCE_FILS)
      };
    } catch (error) {
      result.phoneCheck = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  res.json(result);
});

router.get("/admin/whatsapp-link", requireAuth("admin"), async (_req, res) => {
  const state = getSocketState();
  res.json({
    status: state.status,
    phone: state.phone,
    error: state.error,
    qrDataUrl: state.qr ? await QRCode.toDataURL(state.qr, { margin: 1, width: 280 }) : null
  });
});

router.post("/admin/whatsapp-link/start", requireAuth("admin"), async (_req, res) => {
  void startWhatsAppSocket();
  res.json({ status: getSocketState().status });
});

router.post("/admin/whatsapp-link/logout", requireAuth("admin"), async (_req, res) => {
  await logoutWhatsAppSocket();
  res.json({ status: getSocketState().status });
});

/** Statements for one captain, or for all of them, over an Amman-time period. Amounts are in fils. */
async function loadStatements(period: { start: Date; end: Date }, captainId?: string, includeEntries = false) {
  const [captains, entries, openings] = await Promise.all([
    prisma.captain.findMany({
      where: captainId ? { id: captainId } : {},
      orderBy: { createdAt: "asc" },
      select: { id: true, phone: true, fullName: true, status: true, balanceFils: true }
    }),
    prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: period.start, lt: period.end }, ...(captainId ? { captainId } : {}) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, captainId: true, type: true, amountFils: true, balanceAfterFils: true, description: true,
        reference: true, idempotencyKey: true, createdAt: true
      }
    }),
    prisma.$queryRaw<Array<{ captainId: string; balanceAfterFils: number }>>`
      SELECT DISTINCT ON ("captainId") "captainId", "balanceAfterFils"
      FROM "LedgerEntry"
      WHERE "createdAt" < ${period.start}
      ${captainId ? Prisma.sql`AND "captainId" = ${captainId}` : Prisma.empty}
      ORDER BY "captainId", "createdAt" DESC
    `
  ]);
  const entriesByCaptain = new Map<string, (StatementEntry & { id: string })[]>();
  for (const entry of entries) {
    const list = entriesByCaptain.get(entry.captainId) ?? [];
    list.push(entry);
    entriesByCaptain.set(entry.captainId, list);
  }
  const openingByCaptain = new Map(openings.map((row) => [row.captainId, Number(row.balanceAfterFils)]));
  return captains.map((captain) => ({
    ...captain,
    statement: buildStatement(entriesByCaptain.get(captain.id) ?? [], openingByCaptain.get(captain.id) ?? 0),
    ...(includeEntries ? { entries: entriesByCaptain.get(captain.id) ?? [] } : {})
  }));
}

function readPeriod(query: Record<string, unknown>) {
  return statementPeriod(String(query.from ?? ""), String(query.to ?? ""));
}

router.get("/captain/statement", requireAuth("captain"), async (req, res) => {
  const period = readPeriod(req.query);
  if (!period) {
    res.status(400).json({ error: "اختر تاريخ البداية والنهاية بشكل صحيح." });
    return;
  }
  const [captain] = await loadStatements(period, req.user!.id, true);
  if (!captain) {
    res.status(404).json({ error: "الحساب غير موجود." });
    return;
  }
  res.json({ from: req.query.from, to: req.query.to, captain });
});

router.get("/admin/statements", requireAuth("admin"), async (req, res) => {
  const period = readPeriod(req.query);
  if (!period) {
    res.status(400).json({ error: "اختر تاريخ البداية والنهاية بشكل صحيح." });
    return;
  }
  let captainId: string | undefined;
  if (req.query.phone !== undefined) {
    if (typeof req.query.phone !== "string" || !req.query.phone.trim()) {
      res.status(400).json({ error: "أدخل رقم هاتف صحيحاً للبحث عن كشف الحساب." });
      return;
    }
    let phone: string;
    try {
      phone = normalizePhone(req.query.phone);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
      return;
    }
    const captain = await prisma.captain.findUnique({ where: { phone }, select: { id: true } });
    if (!captain) {
      res.status(404).json({ error: "لا يوجد حساب مسجل بهذا الرقم." });
      return;
    }
    captainId = captain.id;
  }
  const captains = await loadStatements(period, captainId, captainId !== undefined);
  res.json({
    from: req.query.from,
    to: req.query.to,
    captains,
    totals: sumStatements(captains.map((captain) => ({ statement: captain.statement, balanceFils: captain.balanceFils })))
  });
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
    amount: z.union([z.string(), z.number()]).optional(),
    action: z.enum(["credit", "debit", "debit_all"]).default("credit")
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم الهاتف والمبلغ أو اختر سحب كامل الرصيد." });
    return;
  }
  let amountFils = 0;
  if (parsed.data.action !== "debit_all") {
    if (parsed.data.amount === undefined) {
      res.status(400).json({ error: "أدخل المبلغ المطلوب." });
      return;
    }
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
  }
  let phone: string;
  try {
    phone = normalizePhone(String(parsed.data.phone));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }
  const credit = parsed.data.action === "credit";
  try {
    const result = await prisma.$transaction(async (tx) => {
      const captain = await tx.captain.findUnique({ where: { phone } });
      if (!captain) throw new Error("لا يوجد كابتن بهذا الرقم.");
      const debitAmountFils = parsed.data.action === "debit_all" ? captain.balanceFils : amountFils;
      if (!credit && debitAmountFils <= 0) throw new Error("لا يوجد رصيد متاح لسحبه.");
      if (!credit && captain.balanceFils < debitAmountFils) throw new Error("الرصيد تغيّر؛ حدّث البيانات ثم أعد المحاولة.");
      let updated: { balanceFils: number };
      if (credit) {
        updated = await tx.captain.update({
          where: { id: captain.id },
          data: { balanceFils: { increment: amountFils } }
        });
      } else {
        const debited = await tx.captain.updateMany({
          where: parsed.data.action === "debit_all"
            ? { id: captain.id, balanceFils: debitAmountFils }
            : { id: captain.id, balanceFils: { gte: debitAmountFils } },
          data: parsed.data.action === "debit_all"
            ? { balanceFils: 0 }
            : { balanceFils: { decrement: debitAmountFils } }
        });
        if (debited.count !== 1) {
          throw new Error("الرصيد تغيّر؛ حدّث البيانات ثم أعد المحاولة.");
        }
        updated = await tx.captain.findUniqueOrThrow({ where: { id: captain.id }, select: { balanceFils: true } });
      }
      await tx.ledgerEntry.create({
        data: {
          captainId: captain.id,
          type: credit ? LedgerType.CREDIT : LedgerType.ADJUSTMENT,
          amountFils: credit ? amountFils : -debitAmountFils,
          balanceAfterFils: updated.balanceFils,
          description: credit ? "شحن رصيد" : parsed.data.action === "debit_all" ? "سحب كامل الرصيد" : "خصم رصيد"
        }
      });
      return { captain, updated, amountFils: credit ? amountFils : debitAmountFils };
    });
    res.json({
      fullName: result.captain.fullName,
      phone: result.captain.phone,
      amountJod: fromFils(result.amountFils),
      balanceJod: fromFils(result.updated.balanceFils)
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر تنفيذ العملية." });
  }
});

router.post("/admin/commission-transfer", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    consumerPhone: z.string().min(8).max(24),
    productPhone: z.string().min(8).max(24),
    amount: z.union([z.string(), z.number()]),
    requestId: z.string().uuid()
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم المستهلك ورقم المنتج وقيمة العمولة." });
    return;
  }

  let consumerPhone: string;
  let productPhone: string;
  let amountFils: number;
  try {
    consumerPhone = normalizePhone(parsed.data.consumerPhone);
    productPhone = normalizePhone(parsed.data.productPhone);
    amountFils = toFils(parsed.data.amount);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "البيانات المدخلة غير صالحة." });
    return;
  }
  if (amountFils <= 0) {
    res.status(400).json({ error: "يجب أن تكون قيمة العمولة أكبر من صفر." });
    return;
  }
  if (consumerPhone === productPhone) {
    res.status(400).json({ error: "يجب أن يكون رقم المستهلك مختلفاً عن رقم المنتج." });
    return;
  }

  const reference = `commission-transfer:${parsed.data.requestId}`;
  const consumerKey = `${reference}:consumer`;
  const productKey = `${reference}:product`;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const previousEntries = await tx.ledgerEntry.findMany({
        where: { idempotencyKey: { in: [consumerKey, productKey] } }
      });
      if (previousEntries.length) {
        const previousDebit = previousEntries.find((entry) => entry.idempotencyKey === consumerKey);
        const previousCredit = previousEntries.find((entry) => entry.idempotencyKey === productKey);
        if (
          previousEntries.length !== 2 ||
          !previousDebit ||
          !previousCredit ||
          previousDebit.type !== LedgerType.ADJUSTMENT ||
          previousCredit.type !== LedgerType.ADJUSTMENT ||
          previousDebit.reference !== reference ||
          previousCredit.reference !== reference ||
          previousDebit?.amountFils !== -amountFils ||
          previousCredit?.amountFils !== amountFils
        ) {
          return { error: "معرّف العملية مستخدم لتحويل مختلف أو غير مكتمل.", status: 409 as const };
        }
        const [consumer, product] = await Promise.all([
          tx.captain.findUnique({ where: { id: previousDebit.captainId } }),
          tx.captain.findUnique({ where: { id: previousCredit.captainId } })
        ]);
        if (!consumer || !product || consumer.phone !== consumerPhone || product.phone !== productPhone) {
          return { error: "معرّف العملية مستخدم لتحويل مختلف أو غير مكتمل.", status: 409 as const };
        }
        return {
          replayed: true,
          consumer: { phone: consumer.phone, balanceJod: fromFils(consumer.balanceFils) },
          product: { phone: product.phone, balanceJod: fromFils(product.balanceFils) }
        };
      }

      const accounts = await tx.captain.findMany({
        where: { phone: { in: [consumerPhone, productPhone] } }
      });
      const consumer = accounts.find((account) => account.phone === consumerPhone);
      const product = accounts.find((account) => account.phone === productPhone);
      if (!consumer || !product) {
        return { error: "لم يتم العثور على حساب المستهلك أو المنتج.", status: 404 as const };
      }

      const debit = await tx.captain.updateMany({
        where: { id: consumer.id, balanceFils: { gte: amountFils } },
        data: { balanceFils: { decrement: amountFils } }
      });
      if (debit.count !== 1) {
        return { error: "رصيد المستهلك غير كافٍ لإتمام التحويل؛ لا يمكن أن يصبح الرصيد سالباً.", status: 400 as const };
      }
      const updatedConsumer = await tx.captain.findUniqueOrThrow({ where: { id: consumer.id } });
      const updatedProduct = await tx.captain.update({
        where: { id: product.id },
        data: { balanceFils: { increment: amountFils } }
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            captainId: consumer.id,
            type: LedgerType.ADJUSTMENT,
            amountFils: -amountFils,
            balanceAfterFils: updatedConsumer.balanceFils,
            description: `عمولة محولة إلى المنتج ${product.phone}`,
            reference,
            idempotencyKey: consumerKey
          },
          {
            captainId: product.id,
            type: LedgerType.ADJUSTMENT,
            amountFils,
            balanceAfterFils: updatedProduct.balanceFils,
            description: `عمولة مستلمة من المستهلك ${consumer.phone}`,
            reference,
            idempotencyKey: productKey
          }
        ]
      });
      return {
        replayed: false,
        consumer: { phone: consumer.phone, balanceJod: fromFils(updatedConsumer.balanceFils) },
        product: { phone: product.phone, balanceJod: fromFils(updatedProduct.balanceFils) }
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if ("error" in result) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    res.json({ amountJod: fromFils(amountFils), ...result });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      res.status(409).json({ error: "تغير الرصيد أثناء تنفيذ العملية. حدّث البيانات ثم أعد المحاولة." });
      return;
    }
    throw error;
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
    where: { status: "PENDING" },
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

// ==== طلبات سحب الرصيد ====
/** What a captain can still ask to withdraw: their balance minus withdrawals already waiting for review. */
async function availableToWithdrawFils(captainId: string): Promise<{ balanceFils: number; pendingFils: number; availableFils: number }> {
  const [captain, pending] = await Promise.all([
    prisma.captain.findUniqueOrThrow({ where: { id: captainId }, select: { balanceFils: true } }),
    prisma.withdrawalRequest.aggregate({ where: { captainId, status: "PENDING" }, _sum: { amountFils: true } })
  ]);
  const pendingFils = pending._sum.amountFils ?? 0;
  return { balanceFils: captain.balanceFils, pendingFils, availableFils: Math.max(0, captain.balanceFils - pendingFils) };
}

router.get("/captain/withdrawal", requireAuth("captain"), async (req, res) => {
  const { balanceFils, pendingFils, availableFils } = await availableToWithdrawFils(req.user!.id);
  res.json({ balanceJod: fromFils(balanceFils), pendingJod: fromFils(pendingFils), availableJod: fromFils(availableFils) });
});

router.post("/captain/withdrawal", requireAuth("captain"), async (req, res) => {
  const parsed = z.object({ amount: z.union([z.string(), z.number()]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل مبلغ السحب." });
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
    res.status(400).json({ error: "يجب أن يكون مبلغ السحب أكبر من صفر." });
    return;
  }
  // Serializable, so two requests sent together cannot both pass the available-balance check.
  try {
    const created = await prisma.$transaction(async (tx) => {
      const [captain, pending] = await Promise.all([
        tx.captain.findUniqueOrThrow({ where: { id: req.user!.id }, select: { balanceFils: true } }),
        tx.withdrawalRequest.aggregate({ where: { captainId: req.user!.id, status: "PENDING" }, _sum: { amountFils: true } })
      ]);
      const availableFils = Math.max(0, captain.balanceFils - (pending._sum.amountFils ?? 0));
      if (amountFils > availableFils) {
        throw new Error(availableFils > 0
          ? `المبلغ أكبر من الرصيد المتاح للسحب (${fromFils(availableFils)} د.أ).`
          : "لا يوجد رصيد متاح للسحب.");
      }
      return tx.withdrawalRequest.create({ data: { captainId: req.user!.id, amountFils } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ id: created.id, amountJod: fromFils(amountFils) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      res.status(409).json({ error: "تغير الرصيد أثناء إرسال الطلب. أعد المحاولة." });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر إرسال طلب السحب." });
  }
});

router.get("/admin/withdrawals", requireAuth("admin"), async (_req, res) => {
  const requests = await prisma.withdrawalRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      amountFils: true,
      createdAt: true,
      captain: { select: { fullName: true, phone: true, balanceFils: true } }
    }
  });
  res.json(requests.map((request) => ({
    id: request.id,
    captainName: request.captain.fullName ?? request.captain.phone,
    captainPhone: request.captain.phone,
    amountJod: fromFils(request.amountFils),
    balanceJod: fromFils(request.captain.balanceFils),
    createdAt: request.createdAt
  })));
});

router.post("/admin/withdrawals/:id/approve", requireAuth("admin"), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;
  if (!id) {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!request) throw new Error("طلب السحب غير موجود.");
      const claimed = await tx.withdrawalRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "APPROVED", reviewedAt: new Date() }
      });
      if (claimed.count !== 1) throw new Error("تمت معالجة الطلب مسبقاً.");
      // The balance never goes below zero; the throw also undoes the approval above.
      const debited = await tx.captain.updateMany({
        where: { id: request.captainId, balanceFils: { gte: request.amountFils } },
        data: { balanceFils: { decrement: request.amountFils } }
      });
      if (debited.count !== 1) throw new Error("رصيد الكابتن الحالي أقل من المبلغ المطلوب سحبه.");
      const updated = await tx.captain.findUniqueOrThrow({ where: { id: request.captainId } });
      await tx.ledgerEntry.create({
        data: {
          captainId: request.captainId,
          type: LedgerType.ADJUSTMENT,
          amountFils: -request.amountFils,
          balanceAfterFils: updated.balanceFils,
          description: "سحب رصيد",
          reference: `withdrawal:${request.id}`,
          idempotencyKey: `withdrawal:${request.id}`
        }
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ balanceJod: fromFils(result.balanceFils) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر اعتماد طلب السحب." });
  }
});

router.post("/admin/withdrawals/:id/reject", requireAuth("admin"), async (req, res) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;
  if (!id) {
    res.status(400).json({ error: "معرّف غير صالح." });
    return;
  }
  const rejected = await prisma.withdrawalRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REJECTED", reviewedAt: new Date() }
  });
  if (rejected.count !== 1) {
    res.status(400).json({ error: "تمت معالجة الطلب مسبقاً أو غير موجود." });
    return;
  }
  res.json({ ok: true });
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

router.get("/booking/config", async (_req, res) => {
  const [settings, locations, options] = await Promise.all([
    prisma.bookingSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} }),
    prisma.bookingLocation.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.bookingOption.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] })
  ]);
  res.json({
    basePriceJod: fromFils(settings.basePriceFils),
    rearSeatPriceJod: fromFils(settings.rearSeatPriceFils),
    whatsappNumber: settings.whatsappNumber,
    locations,
    options: options.map((option) => ({ ...option, priceJod: fromFils(option.priceFils) }))
  });
});

// Public booking form: no login. Each IP may send a few requests per window to keep spam out.
const BOOKING_WINDOW_MS = 10 * 60 * 1000;
const BOOKINGS_PER_WINDOW = 6;
const bookingAttempts = new Map<string, number[]>();

function bookingRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (bookingAttempts.get(ip) ?? []).filter((time) => now - time < BOOKING_WINDOW_MS);
  if (recent.length >= BOOKINGS_PER_WINDOW) {
    bookingAttempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  bookingAttempts.set(ip, recent);
  if (bookingAttempts.size > 5000) {
    for (const [key, times] of bookingAttempts) {
      if (times.every((time) => now - time >= BOOKING_WINDOW_MS)) bookingAttempts.delete(key);
    }
  }
  return false;
}

/** Finds the customer record for a phone, creating a password-less one for guest bookings. */
async function bookingCustomerFor(phone: string): Promise<{ id: string; phone: string }> {
  const existing = await prisma.bookingCustomer.findUnique({ where: { phone }, select: { id: true, phone: true } });
  if (existing) return existing;
  try {
    // A random hash nobody knows: guest records can never be logged into.
    const passwordHash = await bcrypt.hash(`guest:${crypto.randomUUID()}:${crypto.randomUUID()}`, 10);
    return await prisma.bookingCustomer.create({ data: { phone, passwordHash }, select: { id: true, phone: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.bookingCustomer.findUniqueOrThrow({ where: { phone }, select: { id: true, phone: true } });
    }
    throw error;
  }
}

router.post("/booking/requests", async (req, res) => {
  const ip = req.header("x-real-ip") ?? req.socket.remoteAddress ?? "unknown";
  if (bookingRateLimited(ip)) {
    res.status(429).json({ error: "أرسلت طلبات كثيرة خلال وقت قصير. انتظر بضع دقائق ثم حاول مجدداً." });
    return;
  }
  const parsed = z.object({
    phone: z.string().min(8).max(24),
    pickupLocationId: z.string().min(1).optional(),
    pickupLocationName: z.string().trim().min(2).max(120).optional(),
    pickupAddress: z.string().trim().min(2).max(300),
    pickupLatitude: z.number().finite().min(-90).max(90).nullable().optional(),
    pickupLongitude: z.number().finite().min(-180).max(180).nullable().optional(),
    destinationLocationId: z.string().min(1).optional(),
    destinationLocationName: z.string().trim().min(2).max(120).optional(),
    destinationAddress: z.string().trim().min(2).max(300),
    destinationLatitude: z.number().finite().min(-90).max(90).nullable().optional(),
    destinationLongitude: z.number().finite().min(-180).max(180).nullable().optional(),
    passengerCount: z.number().int().min(1).max(7),
    rearSeat: z.boolean(),
    // The car is an optional line like the rear seat, priced from basePriceFils.
    wholeCar: z.boolean().default(false),
    selections: z.record(z.union([z.string().trim().max(300), z.boolean()])).default({})
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "تحقق من مواقع الانطلاق والوصول وعدد الركاب والحقول المطلوبة." });
    return;
  }
  if ((parsed.data.pickupLatitude === undefined) !== (parsed.data.pickupLongitude === undefined) ||
      (parsed.data.destinationLatitude === undefined) !== (parsed.data.destinationLongitude === undefined)) {
    res.status(400).json({ error: "إحداثيات الموقع غير مكتملة." });
    return;
  }

  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch {
    res.status(400).json({ error: "أدخل رقم هاتف أردنياً صحيحاً مثل 0791234567." });
    return;
  }

  const settings = await prisma.bookingSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  if (!settings.whatsappNumber) {
    res.status(503).json({ error: "لم تضبط الإدارة رقم واتساب لاستقبال الحجوزات بعد." });
    return;
  }

  const [pickup, destination] = await Promise.all([
    parsed.data.pickupLocationId
      ? prisma.bookingLocation.findFirst({ where: { id: parsed.data.pickupLocationId, active: true } })
      : Promise.resolve(null),
    parsed.data.destinationLocationId
      ? prisma.bookingLocation.findFirst({ where: { id: parsed.data.destinationLocationId, active: true } })
      : Promise.resolve(null)
  ]);
  if ((parsed.data.pickupLocationId && !pickup) || (parsed.data.destinationLocationId && !destination) ||
      (!pickup && !parsed.data.pickupLocationName) || (!destination && !parsed.data.destinationLocationName)) {
    res.status(400).json({ error: "اختر موقعاً متاحاً أو اكتب اسم الموقع يدوياً." });
    return;
  }

  const options = await prisma.bookingOption.findMany({ where: { active: true } });
  const optionIds = Object.keys(parsed.data.selections);
  if (optionIds.some((id) => !options.some((option) => option.id === id))) {
    res.status(400).json({ error: "تغيرت خيارات الحجز. حدّث الصفحة ثم حاول مجدداً." });
    return;
  }
  for (const option of options) {
    const value = parsed.data.selections[option.id];
    if (option.required && (value === undefined || value === false || value === "")) {
      res.status(400).json({ error: `الحقل «${option.label}» مطلوب.` });
      return;
    }
    if (option.kind === "ADDON" && value !== undefined && typeof value !== "boolean") {
      res.status(400).json({ error: "قيمة أحد الخيارات غير صالحة." });
      return;
    }
    if (option.kind === "FIELD" && value !== undefined && typeof value !== "string") {
      res.status(400).json({ error: "قيمة أحد الحقول غير صالحة." });
      return;
    }
  }

  const totalPriceFils = (parsed.data.wholeCar ? settings.basePriceFils : 0) +
    (parsed.data.rearSeat ? settings.rearSeatPriceFils : 0) +
    options.reduce((total, option) => total +
      (option.kind === "ADDON" && parsed.data.selections[option.id] === true ? option.priceFils : 0), 0);
  const savedSelections = Object.fromEntries(options
    .filter((option) => parsed.data.selections[option.id] !== undefined)
    .map((option) => [option.id, {
      label: option.label,
      kind: option.kind,
      value: parsed.data.selections[option.id]!,
      priceFils: option.priceFils
    }]));
  // No dedicated column: the admin bookings list already shows every saved selection.
  if (parsed.data.wholeCar) {
    savedSelections.car = { label: "سيارة", kind: "ADDON", value: true, priceFils: settings.basePriceFils };
  }
  const customer = await bookingCustomerFor(phone);
  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      customerPhone: customer.phone,
      pickupLocation: pickup?.name ?? parsed.data.pickupLocationName!,
      pickupAddress: parsed.data.pickupAddress,
      pickupLatitude: parsed.data.pickupLatitude ?? null,
      pickupLongitude: parsed.data.pickupLongitude ?? null,
      destinationLocation: destination?.name ?? parsed.data.destinationLocationName!,
      destinationAddress: parsed.data.destinationAddress,
      destinationLatitude: parsed.data.destinationLatitude ?? null,
      destinationLongitude: parsed.data.destinationLongitude ?? null,
      passengerCount: parsed.data.passengerCount,
      rearSeat: parsed.data.rearSeat,
      selections: savedSelections,
      totalPriceFils
    }
  });
  res.status(201).json({
    id: booking.id,
    totalPriceJod: fromFils(booking.totalPriceFils),
    whatsappNumber: settings.whatsappNumber,
    createdAt: booking.createdAt
  });
});

router.get("/admin/booking/settings", requireAuth("admin"), async (_req, res) => {
  const settings = await prisma.bookingSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  res.json({
    basePriceJod: fromFils(settings.basePriceFils),
    rearSeatPriceJod: fromFils(settings.rearSeatPriceFils),
    whatsappNumber: settings.whatsappNumber
  });
});

router.get("/admin/booking/config", requireAuth("admin"), async (_req, res) => {
  const [settings, locations, options] = await Promise.all([
    prisma.bookingSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} }),
    prisma.bookingLocation.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.bookingOption.findMany({ orderBy: [{ sortOrder: "asc" }, { label: "asc" }] })
  ]);
  res.json({
    settings: {
      basePriceJod: fromFils(settings.basePriceFils),
      rearSeatPriceJod: fromFils(settings.rearSeatPriceFils),
      whatsappNumber: settings.whatsappNumber
    },
    locations,
    options: options.map((option) => ({ ...option, priceJod: fromFils(option.priceFils) }))
  });
});

router.put("/admin/booking/settings", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    basePriceJod: z.union([z.string(), z.number()]),
    rearSeatPriceJod: z.union([z.string(), z.number()]),
    whatsappNumber: z.string().trim().min(8).max(24)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل الأسعار ورقم واتساب صحيحاً." });
    return;
  }
  try {
    const whatsappNumber = normalizePhone(parsed.data.whatsappNumber);
    const settings = await prisma.bookingSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        basePriceFils: toFils(parsed.data.basePriceJod),
        rearSeatPriceFils: toFils(parsed.data.rearSeatPriceJod),
        whatsappNumber
      },
      update: {
        basePriceFils: toFils(parsed.data.basePriceJod),
        rearSeatPriceFils: toFils(parsed.data.rearSeatPriceJod),
        whatsappNumber
      }
    });
    res.json({
      basePriceJod: fromFils(settings.basePriceFils),
      rearSeatPriceJod: fromFils(settings.rearSeatPriceFils),
      whatsappNumber: settings.whatsappNumber
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر حفظ إعدادات الحجز." });
  }
});

router.post("/admin/booking/locations", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(120), sortOrder: z.number().int().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل اسم موقع صحيحاً." });
    return;
  }
  const location = await prisma.bookingLocation.create({ data: parsed.data });
  res.status(201).json(location);
});

router.patch("/admin/booking/locations/:id", requireAuth("admin"), async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(120),
    active: z.boolean(),
    sortOrder: z.number().int()
  }).safeParse(req.body);
  const id = req.params.id;
  if (!parsed.success || typeof id !== "string") {
    res.status(400).json({ error: "بيانات الموقع غير صالحة." });
    return;
  }
  const location = await prisma.bookingLocation.update({ where: { id }, data: parsed.data });
  res.json(location);
});

router.delete("/admin/booking/locations/:id", requireAuth("admin"), async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "معرّف الموقع غير صالح." });
    return;
  }
  await prisma.bookingLocation.delete({ where: { id } });
  res.json({ ok: true });
});

const bookingOptionInput = z.object({
  label: z.string().trim().min(2).max(120),
  kind: z.enum(["ADDON", "FIELD"]),
  priceJod: z.union([z.string(), z.number()]),
  required: z.boolean(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

router.post("/admin/booking/options", requireAuth("admin"), async (req, res) => {
  const parsed = bookingOptionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات الخيار غير صالحة." });
    return;
  }
  try {
    const option = await prisma.bookingOption.create({
      data: {
        label: parsed.data.label,
        kind: parsed.data.kind,
        priceFils: toFils(parsed.data.priceJod),
        required: parsed.data.required,
        active: parsed.data.active ?? true,
        sortOrder: parsed.data.sortOrder ?? 0
      }
    });
    res.status(201).json({ ...option, priceJod: fromFils(option.priceFils) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر حفظ الخيار." });
  }
});

router.patch("/admin/booking/options/:id", requireAuth("admin"), async (req, res) => {
  const parsed = bookingOptionInput.safeParse(req.body);
  const id = req.params.id;
  if (!parsed.success || typeof id !== "string") {
    res.status(400).json({ error: "بيانات الخيار غير صالحة." });
    return;
  }
  try {
    const option = await prisma.bookingOption.update({
      where: { id },
      data: {
        label: parsed.data.label,
        kind: parsed.data.kind,
        priceFils: toFils(parsed.data.priceJod),
        required: parsed.data.required,
        active: parsed.data.active ?? true,
        sortOrder: parsed.data.sortOrder ?? 0
      }
    });
    res.json({ ...option, priceJod: fromFils(option.priceFils) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر تحديث الخيار." });
  }
});

router.delete("/admin/booking/options/:id", requireAuth("admin"), async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "معرّف الخيار غير صالح." });
    return;
  }
  await prisma.bookingOption.delete({ where: { id } });
  res.json({ ok: true });
});

router.get("/admin/booking/customers", requireAuth("admin"), async (req, res) => {
  const search = typeof req.query.phone === "string" ? req.query.phone.replace(/\D/g, "") : "";
  const customers = await prisma.bookingCustomer.findMany({
    where: search ? { phone: { contains: search.replace(/^0/, "") } } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, phone: true, createdAt: true, lockedUntil: true, _count: { select: { bookings: true } } }
  });
  res.json(customers.map(({ _count, ...customer }) => ({ ...customer, bookingCount: _count.bookings })));
});

// Deletes the account and its bookings so the phone number can sign up again.
router.delete("/admin/booking/customers/:id", requireAuth("admin"), async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "معرّف الحساب غير صالح." });
    return;
  }
  const deleted = await prisma.$transaction(async (tx) => {
    const customer = await tx.bookingCustomer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) return null;
    const bookings = await tx.booking.deleteMany({ where: { customerId: id } });
    await tx.bookingCustomer.delete({ where: { id } });
    return { bookings: bookings.count };
  });
  if (!deleted) {
    res.status(404).json({ error: "الحساب غير موجود أو حُذف مسبقاً." });
    return;
  }
  res.json({ ok: true, deletedBookings: deleted.bookings });
});

router.get("/admin/bookings", requireAuth("admin"), async (_req, res) => {
  const bookings = await prisma.booking.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  res.json(bookings.map((booking) => ({
    ...booking,
    totalPriceJod: fromFils(booking.totalPriceFils)
  })));
});
