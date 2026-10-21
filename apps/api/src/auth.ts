import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { normalizePhone } from "./money";

export type UserRole = "captain" | "admin";

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
  const admin = await prisma.admin.findUnique({ where: { phone } });
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
          (payload.role !== "admin" && payload.role !== "captain")) {
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
