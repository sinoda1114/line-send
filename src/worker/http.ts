import type { Context } from "hono";
import type { UserRow } from "./db/users";

export type SessionUser = UserRow & { isAdmin: boolean };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    nowMs: number;
  };
};

type ErrorCode = "INVALID_INPUT" | "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL";

export function fail(
  c: Context,
  status: 400 | 401 | 403 | 500,
  code: ErrorCode,
  message: string,
) {
  return c.json({ success: false, data: null, error: { code, message } }, status);
}

export function toPublicUser(user: SessionUser): {
  id: string;
  displayName: string;
  status: UserRow["status"];
  isAdmin: boolean;
} {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    isAdmin: user.isAdmin,
  };
}
