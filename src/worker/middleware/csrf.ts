import type { MiddlewareHandler } from "hono";
import { fail, type AppEnv } from "../http";

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "POST" && c.req.method !== "DELETE") {
    await next();
    return;
  }
  const media = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const origin = c.req.header("origin");
  const expected = c.env.APP_ORIGIN;
  if (
    media !== "application/json" ||
    typeof expected !== "string" ||
    expected.length === 0 ||
    origin !== expected
  ) {
    return fail(c, 403, "FORBIDDEN", "リクエストを受け付けられません");
  }
  await next();
  return;
};
