import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { normalizePhone } from "./money";

export type UserRole = "captain" | "admin" | "customer";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: UserRole };
    }
  }
}

const loginSchema = z.object({
  phone: z.string().min(8).max(24),
  password: z.string().min(1).max(128)
});

const adminLoginSchema = z.object({
  password: z.string().min(1).max(128)
});

function issueToken(id: string, role: UserRole): string {
  return jwt.sign({ sub: id, role }, config.jwtSecret, { expiresIn: "12h" });
}

export async function captainLogin(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم الهاتف وكلمة المرور." });
    return;
  }

  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }

  const captain = await prisma.captain.findUnique({ where: { phone } });
  if (!captain || !(await bcrypt.compare(parsed.data.password, captain.passwordHash))) {
    res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة." });
    return;
  }
  if (captain.status === "SUSPENDED") {
    res.status(403).json({ error: "الحساب موقوف. يرجى التواصل مع الإدارة." });
    return;
  }
  res.json({
    token: issueToken(captain.id, "captain"),
    needsProfile: captain.status === "PENDING_PROFILE",
    fullName: captain.fullName
  });
}

export async function adminLogin(req: Request, res: Response): Promise<void> {
  const parsed = adminLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل كلمة مرور الإدارة." });
    return;
  }
  const admin = await prisma.admin.findUnique({ where: { id: "admin" } });
  if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
    res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    return;
  }
  res.json({ token: issueToken(admin.id, "admin") });
}

export function requireAuth(role?: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: "يلزم تسجيل الدخول." });
      return;
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      if (typeof payload === "string" || typeof payload.sub !== "string" ||
          (payload.role !== "admin" && payload.role !== "captain" && payload.role !== "customer")) {
        res.status(401).json({ error: "جلسة تسجيل الدخول غير صالحة." });
        return;
      }

      if (role && payload.role !== role) {
        res.status(403).json({ error: "ليس لديك صلاحية لتنفيذ هذا الإجراء." });
        return;
      }
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      res.status(401).json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجدداً." });
    }
  };
}

export async function customerRegister(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    phone: z.string().min(8).max(24),
    password: z.string().min(6).max(128)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم هاتف أردنياً وكلمة مرور من 6 أحرف على الأقل." });
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
    const customer = await prisma.bookingCustomer.create({
      data: { phone, passwordHash: await bcrypt.hash(parsed.data.password, 12) }
    });
    res.status(201).json({ token: issueToken(customer.id, "customer") });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "يوجد حساب مسجل بهذا الرقم. سجّل الدخول بدلاً من إنشاء حساب جديد." });
      return;
    }
    throw error;
  }
}

export async function customerLogin(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    phone: z.string().min(8).max(24),
    password: z.string().min(1).max(128)
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "أدخل رقم الهاتف وكلمة المرور." });
    return;
  }

  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "رقم الهاتف غير صالح." });
    return;
  }

  const customer = await prisma.bookingCustomer.findUnique({ where: { phone } });
  if (!customer) {
    res.status(401).json({ error: "رقم الهاتف أو الرمز غير صحيح." });
    return;
  }
  if (customer.lockedUntil && customer.lockedUntil > new Date()) {
    res.status(429).json({ error: "تم إيقاف المحاولات مؤقتاً بعد إدخال الرمز بشكل خاطئ. حاول بعد 15 دقيقة." });
    return;
  }

  if (!(await bcrypt.compare(parsed.data.password, customer.passwordHash))) {
    const updatedCustomer = await prisma.bookingCustomer.update({
      where: { id: customer.id },
      data: {
        failedLoginAttempts: { increment: 1 }
      }
    });
    const failedLoginAttempts = updatedCustomer.failedLoginAttempts;
    if (failedLoginAttempts >= 5) {
      await prisma.bookingCustomer.update({
        where: { id: customer.id },
        data: { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) }
      });
    }
    res.status(failedLoginAttempts >= 5 ? 429 : 401).json({
      error: failedLoginAttempts >= 5
        ? "تم إيقاف المحاولات مؤقتاً بعد إدخال الرمز بشكل خاطئ. حاول بعد 15 دقيقة."
        : "رقم الهاتف أو الرمز غير صحيح."
    });
    return;
  }

  await prisma.bookingCustomer.update({
    where: { id: customer.id },
    data: { failedLoginAttempts: 0, lockedUntil: null }
  });
  res.json({ token: issueToken(customer.id, "customer") });
}
