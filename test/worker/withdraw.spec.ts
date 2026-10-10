import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sealSession } from "../../src/worker/auth/session-cookie";
import worker from "../../src/worker/index";

const ORIGIN = "https://app.example";
const ME_URL = "https://app.example/api/me";

type UserStatus = "pending" | "active" | "rejected";
type ReminderStatus = "scheduled" | "sending" | "sent" | "failed";

const okBody = { success: true, data: { ok: true }, error: null };

const unauthorized = {
  success: false,
  data: null,
  error: { code: "UNAUTHORIZED", message: "ログインが必要です" },
};

const cannotWithdraw = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "退会できません" },
};

const csrfRejected = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "リクエストを受け付けられません" },
};

const pendingUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a801";
const activeEmptyUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a802";
const activeFullUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a803";
const bodySelfUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a804";
const bodyOtherUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a805";
const rejectedUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a806";
const csrfUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a807";
const raceUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a808";
const neighborUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a810";
const getUser = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a811";
const insertedAdmin = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a809";

function lineUserId(id: string): string {
  return `U${id.replaceAll("-", "")}`;
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sessionCookie(userId: string): Promise<string> {
  const token = await sealSession(env.SESSION_SECRET, userId, Date.now());
  if (token === null) {
    throw new Error("session");
  }
  return `session=${token}`;
}

async function insertUser(id: string, status: UserStatus): Promise<string> {
  const lineId = lineUserId(id);
  if (lineId === env.ADMIN_LINE_USER_ID) {
    throw new Error("admin line id");
  }
  await env.DB.prepare(
    `INSERT INTO users (id, line_user_id, display_name, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, lineId, "テスト", status, "2026-10-10T00:00:00.000Z")
    .run();
  return sessionCookie(id);
}

async function insertReminder(id: string, userId: string, status: ReminderStatus): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      userId,
      "文面",
      "2026-10-10T00:00:00Z",
      "2026-10",
      status,
      "2026-10-10T00:00:00.000Z",
    )
    .run();
}

async function userRow(
  id: string,
): Promise<{ status: string; decided_at: string | null } | null> {
  return env.DB.prepare(`SELECT status, decided_at FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; decided_at: string | null }>();
}

async function reminderCount(userId: string, status?: ReminderStatus): Promise<number> {
  const row =
    status === undefined
      ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1`)
          .bind(userId)
          .first<{ n: number }>()
      : await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = ?2`,
        )
          .bind(userId, status)
          .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countAll(table: "users" | "reminders"): Promise<number> {
  const sql =
    table === "users"
      ? "SELECT COUNT(*) AS n FROM users"
      : "SELECT COUNT(*) AS n FROM reminders";
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  if (!row) {
    throw new Error("count");
  }
  return row.n;
}

function deleteMe(
  cookie: string | undefined,
  options?: { origin?: boolean; contentType?: string; body?: string },
): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  headers.set("content-type", options?.contentType ?? "application/json");
  if (options?.origin !== false) {
    headers.set("origin", ORIGIN);
  }
  return new Request(ME_URL, {
    method: "DELETE",
    headers,
    body: options?.body ?? "{}",
  });
}

function getMe(cookie: string): Request {
  return new Request(ME_URL, { headers: { cookie } });
}

function expectCleared(response: Response): void {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("session="));
  expect(cookie).toContain("Max-Age=0");
}

async function adminCookie(): Promise<{ id: string; cookie: string }> {
  const lineUserId = env.ADMIN_LINE_USER_ID;
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE line_user_id = ?1`)
    .bind(lineUserId)
    .first<{ id: string }>();
  if (existing) {
    return { id: existing.id, cookie: await sessionCookie(existing.id) };
  }
  await env.DB.prepare(
    `INSERT INTO users (id, line_user_id, display_name, status, created_at)
     VALUES (?1, ?2, ?3, 'active', ?4)`,
  )
    .bind(insertedAdmin, lineUserId, "管理者", "2026-10-10T00:00:00.000Z")
    .run();
  return { id: insertedAdmin, cookie: await sessionCookie(insertedAdmin) };
}

describe("withdraw", { concurrent: false }, () => {
  it("申請中の退会は自分の予約だけを消し、Cookie を切る", async () => {
    const cookie = await insertUser(pendingUser, "pending");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b801", pendingUser, "scheduled");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b802", pendingUser, "sending");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b803", pendingUser, "sent");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b804", pendingUser, "failed");
    await insertUser(neighborUser, "active");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b805", neighborUser, "scheduled");

    const response = await call(deleteMe(cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    expectCleared(response);
    expect(await userRow(pendingUser)).toBeNull();
    expect(await reminderCount(pendingUser)).toBe(0);
    expect(await userRow(neighborUser)).toMatchObject({ status: "active" });
    expect(await reminderCount(neighborUser, "scheduled")).toBe(1);

    const again = await call(getMe(cookie));
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual(unauthorized);
  });

  it("承認済みで予約が無くても退会できる", async () => {
    const cookie = await insertUser(activeEmptyUser, "active");
    expect(await reminderCount(activeEmptyUser)).toBe(0);
    const response = await call(deleteMe(cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    expectCleared(response);
    expect(await userRow(activeEmptyUser)).toBeNull();
  });

  it("承認済みの退会は4状態の予約を消す", async () => {
    const cookie = await insertUser(activeFullUser, "active");
    const statuses: ReminderStatus[] = ["scheduled", "sending", "sent", "failed"];
    for (const [index, status] of statuses.entries()) {
      await insertReminder(
        `b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b81${String(index)}`,
        activeFullUser,
        status,
      );
    }
    const response = await call(deleteMe(cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    expect(await userRow(activeFullUser)).toBeNull();
    for (const status of statuses) {
      expect(await reminderCount(activeFullUser, status)).toBe(0);
    }
  });

  it("本文の他人 id は無視して自分だけ消す", async () => {
    const cookie = await insertUser(bodySelfUser, "active");
    await insertUser(bodyOtherUser, "active");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b820", bodyOtherUser, "scheduled");
    const response = await call(
      deleteMe(cookie, { body: JSON.stringify({ id: bodyOtherUser }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okBody);
    expect(await userRow(bodySelfUser)).toBeNull();
    expect(await userRow(bodyOtherUser)).toMatchObject({ status: "active" });
    expect(await reminderCount(bodyOtherUser, "scheduled")).toBe(1);
  });

  it("管理者は退会できず、予約と decided_at を残す", async () => {
    const admin = await adminCookie();
    const reminderId = "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b830";
    await insertReminder(reminderId, admin.id, "scheduled");
    const before = await userRow(admin.id);
    expect(before).toMatchObject({ status: "active", decided_at: null });

    const response = await call(deleteMe(admin.cookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(cannotWithdraw);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await userRow(admin.id)).toMatchObject({ status: "active", decided_at: null });
    expect(await reminderCount(admin.id, "scheduled")).toBe(1);
    const stored = await env.DB.prepare(`SELECT status FROM reminders WHERE id = ?1`)
      .bind(reminderId)
      .first<{ status: string }>();
    expect(stored?.status).toBe("scheduled");
  });

  it("却下済みは退会できず、送った予約を残す", async () => {
    const cookie = await insertUser(rejectedUser, "rejected");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b840", rejectedUser, "sent");
    expect(await reminderCount(rejectedUser, "scheduled")).toBe(0);
    const response = await call(deleteMe(cookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(cannotWithdraw);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await userRow(rejectedUser)).toMatchObject({ status: "rejected" });
    expect(await reminderCount(rejectedUser, "sent")).toBe(1);
  });

  it("未ログインは 401 で行を増減しない", async () => {
    const usersBefore = await countAll("users");
    const remindersBefore = await countAll("reminders");
    const response = await call(deleteMe(undefined));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await countAll("users")).toBe(usersBefore);
    expect(await countAll("reminders")).toBe(remindersBefore);
  });

  it("Origin か Content-Type が不合格なら行も Cookie も残す", async () => {
    const cookie = await insertUser(csrfUser, "active");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b850", csrfUser, "scheduled");
    const requests = [
      deleteMe(cookie, { origin: false }),
      deleteMe(cookie, { contentType: "text/plain" }),
    ];
    for (const request of requests) {
      const response = await call(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(csrfRejected);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await userRow(csrfUser)).toMatchObject({ status: "active" });
    expect(await reminderCount(csrfUser, "scheduled")).toBe(1);
  });

  it("同時の退会は 200 と 401 が1つずつで、行も予約も残らない", async () => {
    const cookie = await insertUser(raceUser, "pending");
    await insertReminder("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b860", raceUser, "scheduled");
    const [left, right] = await Promise.all([call(deleteMe(cookie)), call(deleteMe(cookie))]);
    expect([left.status, right.status].sort()).toEqual([200, 401]);
    const winner = left.status === 200 ? left : right;
    const loser = left.status === 401 ? left : right;
    expect(await winner.json()).toEqual(okBody);
    expect(await loser.json()).toEqual(unauthorized);
    expect(await userRow(raceUser)).toBeNull();
    expect(await reminderCount(raceUser)).toBe(0);
  });

  it("GET /api/me は退会しない", async () => {
    const cookie = await insertUser(getUser, "active");
    const response = await call(getMe(cookie));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(await userRow(getUser)).toMatchObject({ status: "active" });
  });
});
