import type { MiddlewareHandler } from "hono";
import { fail, type AppEnv } from "../http";

export const requireActive: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.status !== "active") {
    return fail(c, 403, "FORBIDDEN", "予約できません");
  }
  await next();
  return;
};
