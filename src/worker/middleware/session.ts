import type { MiddlewareHandler } from "hono";
import {
  clearSessionCookie,
  openSession,
  readSessionCookie,
} from "../auth/session-cookie";
import { findUserById, lineUserIsAdmin } from "../db/users";
import { fail, type AppEnv } from "../http";

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nowMs = Date.now();
  c.set("nowMs", nowMs);
  const token = readSessionCookie(c);
  if (token === undefined) {
    return fail(c, 401, "UNAUTHORIZED", "ログインが必要です");
  }
  const opened = await openSession(c.env.SESSION_SECRET, token, nowMs);
  if (opened === null) {
    clearSessionCookie(c);
    return fail(c, 401, "UNAUTHORIZED", "ログインが必要です");
  }
  const row = await findUserById(c.env.DB, opened.id);
  if (row === null) {
    clearSessionCookie(c);
    return fail(c, 401, "UNAUTHORIZED", "ログインが必要です");
  }
  const isAdmin = await lineUserIsAdmin(row.lineUserId, c.env.ADMIN_LINE_USER_ID);
  c.set("user", { ...row, isAdmin });
  await next();
  return;
};
