import type { Context } from "hono";
import { GLOBAL_LIMIT } from "../../shared/quota";
import { japanYearMonth, monthlyLimit } from "../../shared/time";
import {
  approveUserWithinLimit,
  findRejectTarget,
  findUserDecision,
  lineUserIsAdmin,
  listUsersWithMonthCount,
  rejectUserAndDropScheduled,
  type UserStatus,
} from "../db/users";
import { fail, type AppEnv } from "../http";

const NOT_FOUND = "利用者が見つかりません";

export async function listUsers(c: Context<AppEnv>): Promise<Response> {
  const month = japanYearMonth(c.get("nowMs"));
  const users = await listUsersWithMonthCount(c.env.DB, month);
  const activeCount = users.filter((user) => user.status === "active").length;
  return c.json({
    success: true,
    data: {
      users,
      activeCount,
      monthlyLimit: monthlyLimit(c.env.MONTHLY_LIMIT),
      globalLimit: GLOBAL_LIMIT,
    },
    error: null,
  });
}

export async function approveUser(c: Context<AppEnv>): Promise<Response> {
  const userId = c.req.param("id") ?? "";
  const decidedAt = new Date(c.get("nowMs")).toISOString();
  const changes = await approveUserWithinLimit(
    c.env.DB,
    userId,
    decidedAt,
    monthlyLimit(c.env.MONTHLY_LIMIT),
  );
  if (changes === 1) {
    return c.json({ success: true, data: { ok: true }, error: null });
  }
  if (changes !== 0) {
    throw new Error("承認できません");
  }
  const decision = await findUserDecision(c.env.DB, userId);
  if (decision === null) {
    return fail(c, 404, "NOT_FOUND", NOT_FOUND);
  }
  switch (decision.status) {
    case "active":
      return fail(c, 404, "NOT_FOUND", NOT_FOUND);
    case "pending":
    case "rejected":
      return fail(c, 403, "FORBIDDEN", "全体の上限を超えます");
    default: {
      const neverStatus: never = decision.status;
      throw new Error(neverStatus);
    }
  }
}

export async function rejectUser(c: Context<AppEnv>): Promise<Response> {
  const userId = c.req.param("id") ?? "";
  const target = await findRejectTarget(c.env.DB, userId);
  if (target === null) {
    return fail(c, 404, "NOT_FOUND", NOT_FOUND);
  }
  const targetIsAdmin = await lineUserIsAdmin(target.lineUserId, c.env.ADMIN_LINE_USER_ID);
  if (targetIsAdmin) {
    return fail(c, 403, "FORBIDDEN", "管理者は却下できません");
  }
  if (!canReject(target.status)) {
    return fail(c, 404, "NOT_FOUND", NOT_FOUND);
  }
  const decidedAt = new Date(c.get("nowMs")).toISOString();
  const changes = await rejectUserAndDropScheduled(c.env.DB, userId, decidedAt);
  if (changes === 1) {
    return c.json({ success: true, data: { ok: true }, error: null });
  }
  if (changes === 0) {
    return fail(c, 404, "NOT_FOUND", NOT_FOUND);
  }
  throw new Error("却下できません");
}

function canReject(status: UserStatus): boolean {
  switch (status) {
    case "pending":
    case "active":
      return true;
    case "rejected":
      return false;
    default: {
      const neverStatus: never = status;
      throw new Error(neverStatus);
    }
  }
}
