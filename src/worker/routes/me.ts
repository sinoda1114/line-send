import type { Context } from "hono";
import { japanYearMonth, monthlyLimit } from "../../shared/time";
import { clearSessionCookie } from "../auth/session-cookie";
import { countMonthUsage, deleteWithdrawableUser, findUserDecision } from "../db/users";
import { fail, toPublicUser, type AppEnv } from "../http";

export async function getMe(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const nowMs = c.get("nowMs");
  const month = japanYearMonth(nowMs);
  const count = await countMonthUsage(c.env.DB, user.id, month);
  return c.json({
    success: true,
    data: {
      user: toPublicUser(user),
      usage: {
        month,
        count,
        limit: monthlyLimit(c.env.MONTHLY_LIMIT),
      },
    },
    error: null,
  });
}

export async function deleteMe(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  if (user.isAdmin || user.status === "rejected") {
    return fail(c, 403, "FORBIDDEN", "退会できません");
  }
  const changes = await deleteWithdrawableUser(c.env.DB, user.id);
  if (changes >= 1) {
    clearSessionCookie(c);
    return c.json({ success: true, data: { ok: true }, error: null });
  }
  if (changes !== 0) {
    throw new Error("changes");
  }
  const row = await findUserDecision(c.env.DB, user.id);
  if (row === null) {
    clearSessionCookie(c);
    return fail(c, 401, "UNAUTHORIZED", "ログインが必要です");
  }
  if (row.status === "rejected") {
    return fail(c, 403, "FORBIDDEN", "退会できません");
  }
  throw new Error("changes");
}
