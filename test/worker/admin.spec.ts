import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { japanYearMonth } from "../../src/shared/time";
import { sealSession } from "../../src/worker/auth/session-cookie";
import worker from "../../src/worker/index";

const ORIGIN = "https://app.example";
const ADMIN_URL = "https://app.example/api/admin/users";
const REMINDERS_URL = "https://app.example/api/reminders";

type UserStatus = "pending" | "active" | "rejected";
type ReminderStatus = "scheduled" | "sending" | "sent" | "failed";

type RuntimeBindings = {
  [Key in keyof Env]: Env[Key] extends string ? string : Env[Key];
};

type StoredUser = {
  status: string;
  decided_at: string | null;
  display_name: string;
};

type Actor = {
  id: string;
  lineUserId: string;
  cookie: string;
};

const okBody = { success: true, data: { ok: true }, error: null };

const overLimit = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "全体の上限を超えます" },
};

const notFound = {
  success: false,
  data: null,
  error: { code: "NOT_FOUND", message: "利用者が見つかりません" },
};

const cannotAdmin = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "管理できません" },
};

const cannotRejectAdmin = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "管理者は却下できません" },
};

const cannotReserve = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "予約できません" },
};

const csrfRejected = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "リクエストを受け付けられません" },
};

const unauthorized = {
  success: false,
  data: null,
  error: { code: "UNAUTHORIZED", message: "ログインが必要です" },
};

const quotaExceeded = {
  success: false,
  data: null,
  error: { code: "QUOTA_EXCEEDED", message: "この月の上限に達しています" },
};

function futureSendAt(minutesAhead: number): string {
  const ms = Math.floor(Date.now() / 60_000) * 60_000 + minutesAhead * 60_000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 1) {
    return `${String(year - 1)}-12`;
  }
  return `${String(year)}-${String(monthNumber - 1).padStart(2, "0")}`;
}

function expectIso(value: string | null | undefined): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

async function call(request: Request, bindings: RuntimeBindings = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function insertUser(input: {
  status: UserStatus;
  lineUserId?: string;
  displayName?: string;
  createdAt?: string;
  decidedAt?: string;
}): Promise<Actor> {
  const id = crypto.randomUUID();
  const lineUserId = input.lineUserId ?? `U${id.replaceAll("-", "")}`;
  const displayName = input.displayName ?? "友達";
  const createdAt = input.createdAt ?? "2026-10-10T00:00:00.000Z";
  if (input.decidedAt === undefined) {
    await env.DB.prepare(
      `INSERT INTO users (id, line_user_id, display_name, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(id, lineUserId, displayName, input.status, createdAt)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO users (id, line_user_id, display_name, status, created_at, decided_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(id, lineUserId, displayName, input.status, createdAt, input.decidedAt)
      .run();
  }
  const token = await sealSession(env.SESSION_SECRET, id, Date.now());
  if (token === null) {
    throw new Error("session");
  }
  return { id, lineUserId, cookie: `session=${token}` };
}

async function insertAdmin(displayName = "管理者", createdAt?: string): Promise<Actor> {
  const lineUserId = env.ADMIN_LINE_USER_ID;
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE line_user_id = ?1`)
    .bind(lineUserId)
    .first<{ id: string }>();
  if (existing) {
    if (createdAt !== undefined) {
      await env.DB.prepare(`UPDATE users SET display_name = ?1, created_at = ?2 WHERE id = ?3`)
        .bind(displayName, createdAt, existing.id)
        .run();
    }
    const token = await sealSession(env.SESSION_SECRET, existing.id, Date.now());
    if (token === null) {
      throw new Error("session");
    }
    return { id: existing.id, lineUserId, cookie: `session=${token}` };
  }
  return insertUser({
    status: "active",
    lineUserId,
    displayName,
    createdAt,
  });
}

async function leaveOnlyAdminActive(adminId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET status = 'rejected' WHERE status = 'active' AND id != ?1`,
  )
    .bind(adminId)
    .run();
}

async function insertReminder(
  userId: string,
  status: ReminderStatus,
  sendMonth: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      userId,
      "秘密の文面",
      "2026-10-10T00:00:00Z",
      sendMonth,
      status,
      "2026-10-10T00:00:00.000Z",
    )
    .run();
  return id;
}

async function decision(id: string): Promise<StoredUser | null> {
  return await env.DB.prepare(
    `SELECT status, decided_at, display_name FROM users WHERE id = ?1`,
  )
    .bind(id)
    .first<StoredUser>();
}

async function countActive(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE status = 'active'`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function reminderStatus(id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM reminders WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function countStatus(userId: string, status: ReminderStatus): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = ?2`,
  )
    .bind(userId, status)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function limited(limit: string): RuntimeBindings {
  return { ...env, MONTHLY_LIMIT: limit };
}

function getUsers(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request(ADMIN_URL, { headers });
}

function postAdmin(
  id: string,
  action: "approve" | "reject",
  cookie?: string,
  options?: { origin?: boolean; contentType?: string; body?: unknown },
): Request {
  const headers = new Headers();
  if (options?.origin !== false) {
    headers.set("origin", ORIGIN);
  }
  headers.set("content-type", options?.contentType ?? "application/json");
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  const body = options?.body === undefined ? {} : options.body;
  return new Request(`${ADMIN_URL}/${id}/${action}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function postReminder(cookie: string, sendAt: string): Request {
  return new Request(REMINDERS_URL, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ text: "起こして", sendAt }),
  });
}

async function insertActives(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await insertUser({ status: "active" });
  }
}

describe("admin", { concurrent: false }, () => {
  it("管理者だけの一覧は 1 件である", async () => {
    const admin = await insertAdmin();
    const response = await call(getUsers(admin.cookie));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { users: { id: string }[]; activeCount: number };
    };
    expect(body.data.users).toHaveLength(1);
    expect(body.data.users[0]?.id).toBe(admin.id);
    expect(body.data.activeCount).toBe(1);
  });

  it("一覧は当月の失敗以外を数え、並びと枠を返す", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin("管理者", "2020-01-01T00:00:00.000Z");
    const rejected = await insertUser({
      status: "rejected",
      displayName: "却下さん",
      createdAt: "2020-01-02T00:00:00.000Z",
      decidedAt: "2020-02-01T00:00:00.000Z",
    });
    const pending = await insertUser({
      status: "pending",
      displayName: "申請さん",
      createdAt: "2020-01-03T00:00:00.000Z",
    });
    await insertReminder(pending.id, "scheduled", month);
    await insertReminder(pending.id, "sending", month);
    await insertReminder(pending.id, "sent", month);
    await insertReminder(pending.id, "failed", month);
    await insertReminder(pending.id, "sent", previousMonth(month));
    await insertReminder(rejected.id, "sent", month);
    const response = await call(getUsers(admin.cookie));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        users: {
          id: string;
          displayName: string;
          status: string;
          monthCount: number;
        }[];
        activeCount: number;
        monthlyLimit: number;
        globalLimit: number;
      };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(Object.keys(body.data).sort()).toEqual([
      "activeCount",
      "globalLimit",
      "monthlyLimit",
      "users",
    ]);
    expect(body.data.users.map((user) => user.id)).toEqual([admin.id, rejected.id, pending.id]);
    expect(body.data.users[0]).toEqual({
      id: admin.id,
      displayName: "管理者",
      status: "active",
      monthCount: 0,
    });
    expect(body.data.users[1]).toEqual({
      id: rejected.id,
      displayName: "却下さん",
      status: "rejected",
      monthCount: 1,
    });
    expect(body.data.users[2]).toEqual({
      id: pending.id,
      displayName: "申請さん",
      status: "pending",
      monthCount: 3,
    });
    expect(body.data.activeCount).toBe(1);
    expect(body.data.monthlyLimit).toBe(30);
    expect(body.data.globalLimit).toBe(180);
    const raw = JSON.stringify(body);
    expect(raw.includes("lineUserId")).toBe(false);
    expect(raw.includes(env.ADMIN_LINE_USER_ID)).toBe(false);
    expect(raw.includes(pending.lineUserId)).toBe(false);
    expect(raw.includes("秘密の文面")).toBe(false);
    expect(raw.includes("attempts")).toBe(false);
    expect(raw.includes("decidedAt")).toBe(false);
    expect(raw.includes("last_error")).toBe(false);
  });

  it("申請中は予約できず、承認のあと予約できる", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending", displayName: "友達" });
    const denied = await call(postReminder(friend.cookie, futureSendAt(2)));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(cannotReserve);
    expect(await countStatus(friend.id, "scheduled")).toBe(0);

    const approved = await call(postAdmin(friend.id, "approve", admin.cookie));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(okBody);
    const row = await decision(friend.id);
    expect(row?.status).toBe("active");
    expect(row?.display_name).toBe("友達");
    expectIso(row?.decided_at);

    const created = await call(postReminder(friend.cookie, futureSendAt(2)));
    expect(created.status).toBe(201);
    expect(await countStatus(friend.id, "scheduled")).toBe(1);
  });

  it("180 ちょうどは承認する", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    expect(await countActive()).toBe(1);
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("90"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    expect(await countActive()).toBe(2);
    expect((await decision(friend.id))?.status).toBe("active");
  });

  it("181 以上は承認しない", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("100"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(overLimit);
    expect(await decision(friend.id)).toMatchObject({ status: "pending", decided_at: null });
    expect(await countStatus(friend.id, "scheduled")).toBe(0);
  });

  it("既定の 30 では承認後 6 人まで通す", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    await insertActives(4);
    const friend = await insertUser({ status: "pending" });
    expect(await countActive()).toBe(5);
    const response = await call(postAdmin(friend.id, "approve", admin.cookie));
    expect(response.status).toBe(200);
    expect((await decision(friend.id))?.status).toBe("active");
  });

  it("既定の 30 では承認後 7 人を拒否する", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    await insertActives(5);
    const friend = await insertUser({ status: "pending" });
    expect(await countActive()).toBe(6);
    const response = await call(postAdmin(friend.id, "approve", admin.cookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(overLimit);
    expect(await decision(friend.id)).toMatchObject({ status: "pending", decided_at: null });
  });

  it("申請中は人数に入らない", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const targets: Actor[] = [];
    for (let index = 0; index < 9; index += 1) {
      targets.push(await insertUser({ status: "pending" }));
    }
    const friend = targets[0];
    if (friend === undefined) {
      throw new Error("pending");
    }
    expect(await countActive()).toBe(1);
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("100"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(overLimit);
    expect(await countActive()).toBe(1);
    expect(await decision(friend.id)).toMatchObject({ status: "pending", decided_at: null });
  });

  it("既に承認済みは 404 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "active" });
    const before = await countActive();
    const response = await call(postAdmin(friend.id, "approve", admin.cookie));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFound);
    expect(await decision(friend.id)).toMatchObject({ status: "active", decided_at: null });
    expect(await countActive()).toBe(before);
  });

  it("既に承認済みで枠を超えていても 404 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "active" });
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("100"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFound);
    expect((await decision(friend.id))?.status).toBe("active");
  });

  it("却下済みは枠の中なら再承認でき、送信待ちは戻らない", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({
      status: "rejected",
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
    const sent = await insertReminder(friend.id, "sent", month);
    expect(await countStatus(friend.id, "scheduled")).toBe(0);
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("90"));
    expect(response.status).toBe(200);
    const row = await decision(friend.id);
    expect(row?.status).toBe("active");
    expectIso(row?.decided_at);
    expect(row?.decided_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(await reminderStatus(sent)).toBe("sent");
    expect(await countStatus(friend.id, "scheduled")).toBe(0);
    const created = await call(postReminder(friend.cookie, futureSendAt(2)));
    expect(created.status).toBe(201);
  });

  it("却下済みでも枠を超える再承認は拒否する", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({
      status: "rejected",
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("100"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(overLimit);
    expect(await decision(friend.id)).toMatchObject({
      status: "rejected",
      decided_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("上限 0 でも承認でき、予約は 429 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("0"));
    expect(response.status).toBe(200);
    const created = await call(postReminder(friend.cookie, futureSendAt(2)), limited("0"));
    expect(created.status).toBe(429);
    expect(await created.json()).toEqual(quotaExceeded);
  });

  it("不正な上限は 30 として承認する", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    const response = await call(postAdmin(friend.id, "approve", admin.cookie), limited("nope"));
    expect(response.status).toBe(200);
    expect((await decision(friend.id))?.status).toBe("active");
  });

  it("残枠 1 の同時承認は片方だけ通す", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const first = await insertUser({ status: "pending" });
    const second = await insertUser({ status: "pending" });
    const before = await countActive();
    const [left, right] = await Promise.all([
      call(postAdmin(first.id, "approve", admin.cookie), limited("90")),
      call(postAdmin(second.id, "approve", admin.cookie), limited("90")),
    ]);
    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([200, 403]);
    expect(await countActive()).toBe(before + 1);
    const rows = [await decision(first.id), await decision(second.id)];
    expect(rows.filter((row) => row?.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row?.status === "pending")).toHaveLength(1);
  });

  it("同じ人への同時承認は片方が 404 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    const [left, right] = await Promise.all([
      call(postAdmin(friend.id, "approve", admin.cookie), limited("90")),
      call(postAdmin(friend.id, "approve", admin.cookie), limited("90")),
    ]);
    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([200, 404]);
    const failed = left.status === 404 ? left : right;
    expect(await failed.json()).toEqual(notFound);
    expect(await decision(friend.id)).toMatchObject({ status: "active" });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?1`)
      .bind(friend.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("却下は送信待ちだけを消す", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "active", displayName: "友達" });
    const other = await insertUser({ status: "active" });
    const scheduled = await insertReminder(friend.id, "scheduled", month);
    const sending = await insertReminder(friend.id, "sending", month);
    const sent = await insertReminder(friend.id, "sent", month);
    const failed = await insertReminder(friend.id, "failed", month);
    const otherScheduled = await insertReminder(other.id, "scheduled", month);
    const response = await call(postAdmin(friend.id, "reject", admin.cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    const row = await decision(friend.id);
    expect(row?.status).toBe("rejected");
    expect(row?.display_name).toBe("友達");
    expectIso(row?.decided_at);
    expect(await reminderStatus(scheduled)).toBeNull();
    expect(await reminderStatus(sending)).toBe("sending");
    expect(await reminderStatus(sent)).toBe("sent");
    expect(await reminderStatus(failed)).toBe("failed");
    expect(await reminderStatus(otherScheduled)).toBe("scheduled");
    const denied = await call(postReminder(friend.cookie, futureSendAt(2)));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(cannotReserve);
  });

  it("申請中を却下できる", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    expect(await countStatus(friend.id, "scheduled")).toBe(0);
    const response = await call(postAdmin(friend.id, "reject", admin.cookie));
    expect(response.status).toBe(200);
    const row = await decision(friend.id);
    expect(row?.status).toBe("rejected");
    expectIso(row?.decided_at);
  });

  it("既に却下済みは 404 である", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({
      status: "rejected",
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
    const sent = await insertReminder(friend.id, "sent", month);
    const response = await call(postAdmin(friend.id, "reject", admin.cookie));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFound);
    expect(await decision(friend.id)).toMatchObject({
      status: "rejected",
      decided_at: "2026-01-01T00:00:00.000Z",
    });
    expect(await reminderStatus(sent)).toBe("sent");
    expect(await countStatus(friend.id, "scheduled")).toBe(0);
  });

  it("管理者自身は却下できない", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const scheduled = await insertReminder(admin.id, "scheduled", month);
    const response = await call(postAdmin(admin.id, "reject", admin.cookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(cannotRejectAdmin);
    expect(await decision(admin.id)).toMatchObject({ status: "active", decided_at: null });
    expect(await reminderStatus(scheduled)).toBe("scheduled");
  });

  it("無い id は 404 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const missing = await call(postAdmin(crypto.randomUUID(), "approve", admin.cookie));
    const malformed = await call(postAdmin("not-a-uuid", "reject", admin.cookie));
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await missing.json()).toEqual(notFound);
    expect(await malformed.json()).toEqual(notFound);
  });

  it("管理者でない呼び出しは管理できない", async () => {
    const stranger = await insertUser({ status: "active", displayName: "他人" });
    const friend = await insertUser({ status: "pending", displayName: "申請さん" });
    const listed = await call(getUsers(stranger.cookie));
    const approved = await call(
      postAdmin(friend.id, "approve", stranger.cookie, { body: { status: "active" } }),
    );
    const rejected = await call(
      postAdmin(friend.id, "reject", stranger.cookie, { body: { status: "active" } }),
    );
    expect(listed.status).toBe(403);
    expect(approved.status).toBe(403);
    expect(rejected.status).toBe(403);
    expect(await listed.json()).toEqual(cannotAdmin);
    expect(await approved.json()).toEqual(cannotAdmin);
    expect(await rejected.json()).toEqual(cannotAdmin);
    expect(await decision(friend.id)).toMatchObject({ status: "pending", decided_at: null });
  });

  it("未ログインは 401 である", async () => {
    const friend = await insertUser({ status: "pending" });
    const listed = await call(getUsers());
    const approved = await call(postAdmin(friend.id, "approve"));
    const rejected = await call(postAdmin(friend.id, "reject"));
    expect(listed.status).toBe(401);
    expect(approved.status).toBe(401);
    expect(rejected.status).toBe(401);
    expect(await listed.json()).toEqual(unauthorized);
    expect(await approved.json()).toEqual(unauthorized);
    expect(await rejected.json()).toEqual(unauthorized);
  });

  it("CSRF に失敗した承認は状態も送信待ちも Cookie も変えない", async () => {
    const month = japanYearMonth(Date.now());
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const friend = await insertUser({ status: "pending" });
    const scheduled = await insertReminder(friend.id, "scheduled", month);
    const noOrigin = await call(
      postAdmin(friend.id, "approve", admin.cookie, { origin: false }),
    );
    const plain = await call(
      postAdmin(friend.id, "reject", admin.cookie, { contentType: "text/plain" }),
    );
    expect(noOrigin.status).toBe(403);
    expect(plain.status).toBe(403);
    expect(await noOrigin.json()).toEqual(csrfRejected);
    expect(await plain.json()).toEqual(csrfRejected);
    expect(noOrigin.headers.get("set-cookie")).toBeNull();
    expect(plain.headers.get("set-cookie")).toBeNull();
    expect(await decision(friend.id)).toMatchObject({ status: "pending", decided_at: null });
    expect(await reminderStatus(scheduled)).toBe("scheduled");
  });

  it("一覧の GET は Origin が無くても 200 である", async () => {
    const admin = await insertAdmin();
    await leaveOnlyAdminActive(admin.id);
    const response = await call(getUsers(admin.cookie));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
