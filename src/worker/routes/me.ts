import type { Context } from "hono";
import { japanYearMonth, monthlyLimit } from "../../shared/time";
import { countMonthUsage } from "../db/users";
import { toPublicUser, type AppEnv } from "../http";

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
