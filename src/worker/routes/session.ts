import type { Context } from "hono";
import {
  SESSION_MAX_AGE,
  clearSessionCookie,
  sealSession,
  writeSessionCookie,
} from "../auth/session-cookie";
import { findOrCreateUser, lineUserIsAdmin } from "../db/users";
import { fail, toPublicUser, type AppEnv } from "../http";
import { verifyIdToken } from "../line/verify-id-token";

const ID_TOKEN_MAX = 4096;
const encoder = new TextEncoder();

export async function createSession(c: Context<AppEnv>): Promise<Response> {
  const nowMs = Date.now();
  if (encoder.encode(c.env.SESSION_SECRET).byteLength < 32) {
    return fail(c, 500, "INTERNAL", "ログインできません");
  }
  const idToken = await readIdToken(c);
  if (idToken === null) {
    return fail(c, 400, "INVALID_INPUT", "入力が不正です");
  }
  const verified = await verifyIdToken(c.env.LINE_LOGIN_CHANNEL_ID, idToken, nowMs);
  if (verified === null) {
    return fail(c, 401, "UNAUTHORIZED", "ログインできません");
  }
  const isAdmin = await lineUserIsAdmin(verified.sub, c.env.ADMIN_LINE_USER_ID);
  const user = await findOrCreateUser(
    c.env.DB,
    verified.sub,
    verified.displayName,
    isAdmin ? "active" : "pending",
    new Date(nowMs).toISOString(),
  );
  const token = await sealSession(c.env.SESSION_SECRET, user.id, nowMs);
  if (token === null) {
    return fail(c, 500, "INTERNAL", "ログインできません");
  }
  writeSessionCookie(c, token, SESSION_MAX_AGE);
  return c.json({
    success: true,
    data: { user: toPublicUser({ ...user, isAdmin }) },
    error: null,
  });
}

export function deleteSession(c: Context<AppEnv>): Response {
  clearSessionCookie(c);
  return c.json({ success: true, data: { ok: true }, error: null });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readIdToken(c: Context<AppEnv>): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!isRecord(body) || !("idToken" in body)) {
    return null;
  }
  const idToken = body.idToken;
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > ID_TOKEN_MAX) {
    return null;
  }
  return idToken;
}
