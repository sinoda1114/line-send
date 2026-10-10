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
