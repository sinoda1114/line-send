import type { Context } from "hono";
import { countMonthUsage } from "../db/users";
import { toPublicUser, type AppEnv } from "../http";

export function japanYearMonth(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (year === undefined || month === undefined) {
    throw new Error("month");
  }
  return `${year}-${month}`;
}

export function monthlyLimit(value: string): number {
  if (value === "") {
    return 30;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 30;
  }
  return parsed;
}

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
