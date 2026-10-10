import { GLOBAL_LIMIT } from "../../shared/quota";

declare global {
  interface SubtleCrypto {
    timingSafeEqual(
      a: ArrayBuffer | ArrayBufferView,
      b: ArrayBuffer | ArrayBufferView,
    ): boolean;
  }
}

export type UserStatus = "pending" | "active" | "rejected";

export type UserRow = {
  id: string;
  lineUserId: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  decidedAt: string | null;
};

type UserSql = {
  id: string;
  line_user_id: string;
  display_name: string;
  status: UserStatus;
  created_at: string;
  decided_at: string | null;
};

const encoder = new TextEncoder();

export async function lineUserIsAdmin(
  lineUserId: string,
  adminLineUserId: string,
): Promise<boolean> {
  if (lineUserId.length === 0 || adminLineUserId.length === 0) {
    return false;
  }
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(lineUserId)),
    crypto.subtle.digest("SHA-256", encoder.encode(adminLineUserId)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function findUserByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, line_user_id, display_name, status, created_at, decided_at
       FROM users WHERE line_user_id = ?1`,
    )
    .bind(lineUserId)
    .first<UserSql>();
  return row === null ? null : mapUser(row);
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, line_user_id, display_name, status, created_at, decided_at
       FROM users WHERE id = ?1`,
    )
    .bind(id)
    .first<UserSql>();
  return row === null ? null : mapUser(row);
}

export async function findOrCreateUser(
  db: D1Database,
  lineUserId: string,
  displayName: string,
  status: "pending" | "active",
  createdAt: string,
): Promise<UserRow> {
  const existing = await findUserByLineUserId(db, lineUserId);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO users (id, line_user_id, display_name, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(id, lineUserId, displayName, status, createdAt)
      .run();
  } catch (error) {
    const raced = await findUserByLineUserId(db, lineUserId);
    if (raced) {
      return raced;
    }
    throw error;
  }
  const created = await findUserById(db, id);
  if (!created) {
    throw new Error("利用者を作成できません");
  }
  return created;
}

export async function countMonthUsage(
  db: D1Database,
  userId: string,
  month: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reminders
       WHERE user_id = ?1 AND send_month = ?2 AND status != 'failed'`,
    )
    .bind(userId, month)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type AdminListedUser = {
  id: string;
  displayName: string;
  status: UserStatus;
  monthCount: number;
};

type AdminListedSql = {
  id: string;
  display_name: string;
  status: UserStatus;
  created_at: string;
  month_count: number;
};

export type UserDecision = {
  status: UserStatus;
  decidedAt: string | null;
};

export type RejectTarget = {
  id: string;
  lineUserId: string;
  status: UserStatus;
  decidedAt: string | null;
};

type RejectTargetSql = {
  id: string;
  line_user_id: string;
  status: UserStatus;
  decided_at: string | null;
};

export async function listUsersWithMonthCount(
  db: D1Database,
  month: string,
): Promise<AdminListedUser[]> {
  const listed = await db
    .prepare(
      `SELECT u.id, u.display_name, u.status, u.created_at,
              (SELECT COUNT(*) FROM reminders AS r
               WHERE r.user_id = u.id AND r.send_month = ?1 AND r.status != 'failed') AS month_count
       FROM users AS u
       ORDER BY u.created_at ASC, u.id ASC`,
    )
    .bind(month)
    .all<AdminListedSql>();
  return listed.results.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    monthCount: row.month_count,
  }));
}

export async function approveUserWithinLimit(
  db: D1Database,
  userId: string,
  decidedAt: string,
  limit: number,
): Promise<number> {
  const updated = await db
    .prepare(
      `UPDATE users
       SET status = 'active', decided_at = ?1
       WHERE id = ?2
         AND status IN ('pending', 'rejected')
         AND ((SELECT COUNT(*) FROM users WHERE status = 'active') + 1) * ?3 <= ?4`,
    )
    .bind(decidedAt, userId, limit, GLOBAL_LIMIT)
    .run();
  return updated.meta.changes;
}

export async function deleteWithdrawableUser(db: D1Database, userId: string): Promise<number> {
  const deleted = await db
    .prepare(
      `DELETE FROM users
       WHERE id = ?1 AND status IN ('pending', 'active')`,
    )
    .bind(userId)
    .run();
  return deleted.meta.changes;
}

export async function findUserDecision(
  db: D1Database,
  userId: string,
): Promise<UserDecision | null> {
  const row = await db
    .prepare(`SELECT status, decided_at FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ status: UserStatus; decided_at: string | null }>();
  if (row === null) {
    return null;
  }
  return { status: row.status, decidedAt: row.decided_at };
}

export async function findRejectTarget(
  db: D1Database,
  userId: string,
): Promise<RejectTarget | null> {
  const row = await db
    .prepare(
      `SELECT id, line_user_id, status, decided_at FROM users WHERE id = ?1`,
    )
    .bind(userId)
    .first<RejectTargetSql>();
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    status: row.status,
    decidedAt: row.decided_at,
  };
}

export async function rejectUserAndDropScheduled(
  db: D1Database,
  userId: string,
  decidedAt: string,
): Promise<number> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users
         SET status = 'rejected', decided_at = ?1
         WHERE id = ?2 AND status IN ('pending', 'active')`,
      )
      .bind(decidedAt, userId),
    db
      .prepare(
        `DELETE FROM reminders
         WHERE user_id = ?1 AND status = 'scheduled'`,
      )
      .bind(userId),
  ]);
  const updated = results[0];
  if (updated === undefined) {
    throw new Error("却下できません");
  }
  return updated.meta.changes;
}

function mapUser(row: UserSql): UserRow {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
