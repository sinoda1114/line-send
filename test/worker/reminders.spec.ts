import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { japanYearMonth } from "../../src/shared/time";
import { sealSession } from "../../src/worker/auth/session-cookie";
import worker from "../../src/worker/index";

const ORIGIN = "https://app.example";
const REMINDERS_URL = "https://app.example/api/reminders";
const ME_URL = "https://app.example/api/me";

type UserStatus = "pending" | "active" | "rejected";
type ReminderStatus = "scheduled" | "sending" | "sent" | "failed";

type ReminderJson = {
  id: string;
  text: string;
  sendAt: string;
  sendMonth: string;
  status: string;
  sentAt: string | null;
};

type CreatedBody = {
  success: true;
  data: { reminder: ReminderJson };
  error: null;
};

type ListBody = {
  success: true;
  data: { reminders: ReminderJson[] };
  error: null;
};

type MeBody = {
  success: true;
  data: {
    user: { id: string };
    usage: { month: string; count: number; limit: number };
  };
  error: null;
};

type StoredReminder = {
  user_id: string;
  text: string;
  send_at: string;
  send_month: string;
  status: string;
  sent_at: string | null;
  attempts: number;
};

type Actor = {
  id: string;
  cookie: string;
};

type RuntimeBindings = {
  [Key in keyof Env]: Env[Key] extends string ? string : Env[Key];
};

const invalidInput = {
  success: false,
  data: null,
  error: { code: "INVALID_INPUT", message: "入力が不正です" },
};

const quotaExceeded = {
  success: false,
  data: null,
  error: { code: "QUOTA_EXCEEDED", message: "この月の上限に達しています" },
};

const notFound = {
  success: false,
  data: null,
  error: { code: "NOT_FOUND", message: "予約が見つかりません" },
};

const forbiddenActive = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "予約できません" },
};

const forbiddenRequest = {
  success: false,
  data: null,
  error: { code: "FORBIDDEN", message: "リクエストを受け付けられません" },
};

function futureSendAt(minutesAhead: number): string {
  const ms = Math.floor(Date.now() / 60_000) * 60_000 + minutesAhead * 60_000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function call(request: Request, bindings: RuntimeBindings = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createUser(status: UserStatus, lineUserId?: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const line = lineUserId ?? `U${id.replaceAll("-", "")}`;
  const existing = await env.DB.prepare("SELECT id, status FROM users WHERE line_user_id = ?1")
    .bind(line)
    .first<{ id: string; status: string }>();
  const userId = existing?.id ?? id;
  if (existing === null) {
    await env.DB.prepare(
      "INSERT INTO users (id, line_user_id, display_name, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(userId, line, "テスト", status, "2026-10-10T00:00:00.000Z")
      .run();
  } else if (existing.status !== status) {
    await env.DB.prepare("UPDATE users SET status = ?1 WHERE id = ?2").bind(status, userId).run();
  }
  const token = await sealSession(env.SESSION_SECRET, userId, Date.now());
  if (token === null) {
    throw new Error("session");
  }
  return { id: userId, cookie: `session=${token}` };
}

async function insertReminder(
  id: string,
  userId: string,
  status: ReminderStatus,
  sendAt: string,
  sendMonth: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(id, userId, "文面", sendAt, sendMonth, status, "2026-10-10T00:00:00.000Z")
    .run();
}

async function reminderCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function quotaCount(userId: string, sendMonth: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reminders
     WHERE user_id = ?1 AND send_month = ?2 AND status != 'failed'`,
  )
    .bind(userId, sendMonth)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function reminderById(id: string): Promise<StoredReminder | null> {
  return await env.DB.prepare(
    `SELECT user_id, text, send_at, send_month, status, sent_at, attempts
     FROM reminders WHERE id = ?1`,
  )
    .bind(id)
    .first<StoredReminder>();
}

function postReminders(
  cookie: string | undefined,
  body: unknown,
  options?: { origin?: boolean; contentType?: string },
): Request {
  const headers = new Headers();
  if (options?.origin !== false) {
    headers.set("origin", ORIGIN);
  }
  headers.set("content-type", options?.contentType ?? "application/json");
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request(REMINDERS_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getReminders(
  cookie: string,
  view?: string | readonly string[],
): Request {
  const url = new URL(REMINDERS_URL);
  if (typeof view === "string") {
    url.searchParams.set("view", view);
  } else if (view !== undefined) {
    for (const item of view) {
      url.searchParams.append("view", item);
    }
  }
  return new Request(url, { headers: { cookie } });
}

function deleteReminders(
  cookie: string,
  id: string,
  options?: { origin?: boolean },
): Request {
  const headers = new Headers({
    cookie,
    "content-type": "application/json",
  });
  if (options?.origin !== false) {
    headers.set("origin", ORIGIN);
  }
  return new Request(`${REMINDERS_URL}/${id}`, { method: "DELETE", headers });
}

function meRequest(cookie: string): Request {
  return new Request(ME_URL, { headers: { cookie } });
}

async function readCreated(response: Response): Promise<CreatedBody> {
  return (await response.json()) as CreatedBody;
}

async function readList(response: Response): Promise<ListBody> {
  return (await response.json()) as ListBody;
}

describe("reminders", { concurrent: false }, () => {
  it("作成は文面を整え、scheduled で 201 を返す", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const response = await call(postReminders(user.cookie, { text: "  あ  ", sendAt }));
    expect(response.status).toBe(201);
    const body = await readCreated(response);
    expect(body.error).toBeNull();
    expect(Object.keys(body.data.reminder).sort()).toEqual([
      "id",
      "sendAt",
      "sendMonth",
      "sentAt",
      "status",
      "text",
    ]);
    expect(body.data.reminder).toMatchObject({
      text: "あ",
      sendAt,
      status: "scheduled",
      sentAt: null,
    });
    expect(body.data.reminder.sendAt.endsWith(":00Z")).toBe(true);
    const stored = await reminderById(body.data.reminder.id);
    expect(stored).toMatchObject({
      user_id: user.id,
      text: "あ",
      send_at: sendAt,
      status: "scheduled",
      sent_at: null,
      attempts: 0,
    });
    expect(await reminderCount(user.id)).toBe(1);
  });

  it("send_month は切り捨て後の日本時間で、本文の sendMonth は捨てる", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const response = await call(
      postReminders(user.cookie, { text: "あ", sendAt, sendMonth: "1999-01" }),
    );
    expect(response.status).toBe(201);
    const body = await readCreated(response);
    const stored = await reminderById(body.data.reminder.id);
    const expected = japanYearMonth(Date.parse(sendAt));
    expect(stored?.send_month).toBe(expected);
    expect(body.data.reminder.sendMonth).toBe(expected);
    expect(stored?.send_month).not.toBe("1999-01");
  });

  it("不正な入力は 400 で行を増やさない", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const bodies: unknown[] = [
      "not-json",
      { text: 1, sendAt },
      { text: "", sendAt },
      { text: "あ".repeat(5001), sendAt },
      { text: "あ", sendAt: "2020-01-01T00:00:00Z" },
      { text: "あ", sendAt: sendAt.slice(0, -1) },
    ];
    for (const body of bodies) {
      const response = await call(postReminders(user.cookie, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(invalidInput);
    }
    expect(await reminderCount(user.id)).toBe(0);
  });

  it("1年を超える送信時刻は 400 で行を増やさない", async () => {
    const user = await createUser("active");
    const response = await call(
      postReminders(user.cookie, { text: "あ", sendAt: futureSendAt(400 * 24 * 60) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(invalidInput);
    expect(await reminderCount(user.id)).toBe(0);
  });

  it("未ログインは 401 で行を増やさない", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>();
    const response = await call(
      postReminders(undefined, { text: "あ", sendAt: futureSendAt(2) }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      data: null,
      error: { code: "UNAUTHORIZED", message: "ログインが必要です" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("未承認は本文が正しくても壊れていても 403 で、一覧も見られない", async () => {
    const user = await createUser("pending");
    const sendAt = futureSendAt(2);
    const created = await call(postReminders(user.cookie, { text: "あ", sendAt }));
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual(forbiddenActive);
    const broken = await call(postReminders(user.cookie, {}));
    expect(broken.status).toBe(403);
    expect(await broken.json()).toEqual(forbiddenActive);
    const id = crypto.randomUUID();
    await insertReminder(id, user.id, "scheduled", sendAt, japanYearMonth(Date.parse(sendAt)));
    const listed = await call(getReminders(user.cookie, "upcoming"));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual(forbiddenActive);
    expect((await reminderById(id))?.status).toBe("scheduled");
    expect(await reminderCount(user.id)).toBe(1);
  });

  it("却下は一覧も作成も取り消しもしない", async () => {
    const user = await createUser("rejected");
    const requests = [
      getReminders(user.cookie, "upcoming"),
      postReminders(user.cookie, { text: "あ", sendAt: futureSendAt(2) }),
      deleteReminders(user.cookie, crypto.randomUUID()),
    ];
    for (const request of requests) {
      const response = await call(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(forbiddenActive);
    }
    expect(await reminderCount(user.id)).toBe(0);
  });

  it("管理者も active なら予約できる", async () => {
    const user = await createUser("active", env.ADMIN_LINE_USER_ID);
    const before = await reminderCount(user.id);
    const response = await call(
      postReminders(user.cookie, { text: "あ", sendAt: futureSendAt(2) }),
    );
    expect(response.status).toBe(201);
    expect(await reminderCount(user.id)).toBe(before + 1);
  });

  it("Origin か Content-Type が不合格なら 403 で行も Cookie も変えない", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const requests = [
      postReminders(user.cookie, { text: "あ", sendAt }, { origin: false }),
      postReminders(user.cookie, { text: "あ", sendAt }, { contentType: "text/plain" }),
    ];
    for (const request of requests) {
      const response = await call(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(forbiddenRequest);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await reminderCount(user.id)).toBe(0);
  });

  it("同じ月の2件目は上限 1 で 429 になる", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const bindings = { ...env, MONTHLY_LIMIT: "1" };
    const first = await call(postReminders(user.cookie, { text: "あ", sendAt }), bindings);
    expect(first.status).toBe(201);
    const second = await call(postReminders(user.cookie, { text: "い", sendAt }), bindings);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual(quotaExceeded);
    expect(await quotaCount(user.id, japanYearMonth(Date.parse(sendAt)))).toBe(1);
  });

  it("上限 0 は 429 で行を増やさない", async () => {
    const user = await createUser("active");
    const response = await call(
      postReminders(user.cookie, { text: "あ", sendAt: futureSendAt(2) }),
      { ...env, MONTHLY_LIMIT: "0" },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(quotaExceeded);
    expect(await reminderCount(user.id)).toBe(0);
  });

  it("整数でない上限は 30 として 1 件作れる", async () => {
    const user = await createUser("active");
    const response = await call(
      postReminders(user.cookie, { text: "あ", sendAt: futureSendAt(2) }),
      { ...env, MONTHLY_LIMIT: "nope" },
    );
    expect(response.status).toBe(201);
    expect(await reminderCount(user.id)).toBe(1);
  });

  it("failed は月間件数に入らない", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const month = japanYearMonth(Date.parse(sendAt));
    await insertReminder(crypto.randomUUID(), user.id, "failed", sendAt, month);
    const response = await call(postReminders(user.cookie, { text: "あ", sendAt }), {
      ...env,
      MONTHLY_LIMIT: "1",
    });
    expect(response.status).toBe(201);
    expect(await quotaCount(user.id, month)).toBe(1);
  });

  it("sending は枠を使い、取り消しは 404 のまま残る", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const month = japanYearMonth(Date.parse(sendAt));
    const id = crypto.randomUUID();
    await insertReminder(id, user.id, "sending", sendAt, month);
    const created = await call(postReminders(user.cookie, { text: "あ", sendAt }), {
      ...env,
      MONTHLY_LIMIT: "1",
    });
    expect(created.status).toBe(429);
    expect(await created.json()).toEqual(quotaExceeded);
    const deleted = await call(deleteReminders(user.cookie, id));
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual(notFound);
    expect((await reminderById(id))?.status).toBe("sending");
  });

  it("別の send_month は上限 1 でも作れる", async () => {
    const user = await createUser("active");
    const near = futureSendAt(2);
    const far = futureSendAt(40 * 24 * 60);
    const bindings = { ...env, MONTHLY_LIMIT: "1" };
    const first = await call(postReminders(user.cookie, { text: "あ", sendAt: near }), bindings);
    expect(first.status).toBe(201);
    const second = await call(postReminders(user.cookie, { text: "い", sendAt: far }), bindings);
    expect(second.status).toBe(201);
    const nearMonth = (await reminderById((await readCreated(first)).data.reminder.id))?.send_month;
    const farMonth = (await reminderById((await readCreated(second)).data.reminder.id))?.send_month;
    expect(nearMonth).toBe(japanYearMonth(Date.parse(near)));
    expect(farMonth).toBe(japanYearMonth(Date.parse(far)));
    expect(nearMonth).not.toBe(farMonth);
  });

  it("他人の件数は自分の上限に入らない", async () => {
    const user = await createUser("active");
    const other = await createUser("active");
    const sendAt = futureSendAt(2);
    const month = japanYearMonth(Date.parse(sendAt));
    for (let index = 0; index < 5; index += 1) {
      await insertReminder(crypto.randomUUID(), other.id, "scheduled", sendAt, month);
    }
    const response = await call(postReminders(user.cookie, { text: "あ", sendAt }), {
      ...env,
      MONTHLY_LIMIT: "1",
    });
    expect(response.status).toBe(201);
    expect(await quotaCount(user.id, month)).toBe(1);
    expect(await quotaCount(other.id, month)).toBe(5);
  });

  it("残枠 1 の同時作成は片方だけ 201 になる", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const bindings = { ...env, MONTHLY_LIMIT: "1" };
    const body = { text: "あ", sendAt };
    const [left, right] = await Promise.all([
      call(postReminders(user.cookie, body), bindings),
      call(postReminders(user.cookie, body), bindings),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 429]);
    const loser = left.status === 429 ? left : right;
    expect(await loser.json()).toEqual(quotaExceeded);
    expect(await quotaCount(user.id, japanYearMonth(Date.parse(sendAt)))).toBe(1);
    expect(await reminderCount(user.id)).toBe(1);
  });

  it("上限を下げても既にある予約は残る", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const created = await call(postReminders(user.cookie, { text: "あ", sendAt }));
    expect(created.status).toBe(201);
    const listed = await call(getReminders(user.cookie, "upcoming"), {
      ...env,
      MONTHLY_LIMIT: "1",
    });
    expect(listed.status).toBe(200);
    expect((await readList(listed)).data.reminders).toHaveLength(1);
    const second = await call(postReminders(user.cookie, { text: "い", sendAt }), {
      ...env,
      MONTHLY_LIMIT: "1",
    });
    expect(second.status).toBe(429);
    expect(await reminderCount(user.id)).toBe(1);
  });

  it("来月の予約は当月の usage.count を増やさない", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(40 * 24 * 60);
    const created = await call(postReminders(user.cookie, { text: "あ", sendAt }));
    expect(created.status).toBe(201);
    const body = await readCreated(created);
    expect(body.data.reminder.sendMonth).toBe(japanYearMonth(Date.parse(sendAt)));
    expect(body.data.reminder.sendMonth).not.toBe(japanYearMonth(Date.now()));
    const me = await call(meRequest(user.cookie));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as MeBody;
    expect(meBody.data.usage.count).toBe(0);
    expect(meBody.data.usage.limit).toBe(30);
  });

  it("一覧は自分の upcoming と history だけを時刻順で返す", async () => {
    const user = await createUser("active");
    const other = await createUser("active");
    const scheduledEarly = crypto.randomUUID();
    const sendingMiddle = crypto.randomUUID();
    const scheduledLate = crypto.randomUUID();
    const sent = crypto.randomUUID();
    const failed = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await insertReminder(scheduledEarly, user.id, "scheduled", "2026-06-01T00:00:00Z", "2026-06");
    await insertReminder(sendingMiddle, user.id, "sending", "2026-06-01T00:01:00Z", "2026-06");
    await insertReminder(scheduledLate, user.id, "scheduled", "2026-06-01T00:02:00Z", "2026-06");
    await insertReminder(sent, user.id, "sent", "2026-06-01T00:03:00Z", "2026-06");
    await insertReminder(failed, user.id, "failed", "2026-06-01T00:04:00Z", "2026-06");
    await insertReminder(foreign, other.id, "scheduled", "2026-06-01T00:00:00Z", "2026-06");
    const upcoming = await readList(await call(getReminders(user.cookie, "upcoming")));
    expect(upcoming.data.reminders.map((item) => item.id)).toEqual([
      scheduledEarly,
      sendingMiddle,
      scheduledLate,
    ]);
    expect(upcoming.data.reminders.map((item) => item.status)).toEqual([
      "scheduled",
      "sending",
      "scheduled",
    ]);
    const history = await readList(await call(getReminders(user.cookie, "history")));
    expect(history.data.reminders.map((item) => item.id)).toEqual([failed, sent]);
    expect(history.data.reminders.map((item) => item.status)).toEqual(["failed", "sent"]);
    expect(history.data.reminders.map((item) => item.sendAt)).toEqual([
      "2026-06-01T00:04:00Z",
      "2026-06-01T00:03:00Z",
    ]);
  });

  it("history は新しい順の 50 件までで、最も早い send_at を落とす", async () => {
    const user = await createUser("active");
    const base = Date.parse("2024-01-01T00:00:00Z");
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      const sendAt = new Date(base + index * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      await insertReminder(id, user.id, "sent", sendAt, "2024-01");
    }
    const history = await readList(await call(getReminders(user.cookie, "history")));
    expect(history.data.reminders).toHaveLength(50);
    expect(history.data.reminders.map((item) => item.id)).not.toContain(ids[0]);
    expect(history.data.reminders[0]?.id).toBe(ids[50]);
    expect(history.data.reminders[49]?.id).toBe(ids[1]);
  });

  it("0 件の upcoming は 200 で空配列", async () => {
    const user = await createUser("active");
    const response = await call(getReminders(user.cookie, "upcoming"));
    expect(response.status).toBe(200);
    expect(await readList(response)).toEqual({
      success: true,
      data: { reminders: [] },
      error: null,
    });
  });

  it("view が無い、配列、upcoming と history 以外は 400", async () => {
    const user = await createUser("active");
    const requests = [
      getReminders(user.cookie),
      getReminders(user.cookie, "nope"),
      getReminders(user.cookie, ["upcoming", "history"]),
    ];
    for (const request of requests) {
      const response = await call(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(invalidInput);
    }
  });

  it("GET は Origin が無くても 200", async () => {
    const user = await createUser("active");
    const response = await call(getReminders(user.cookie, "upcoming"));
    expect(response.status).toBe(200);
    expect((await readList(response)).data.reminders).toEqual([]);
  });

  it("自分の scheduled は取り消せ、同じ月の枠が空く", async () => {
    const user = await createUser("active");
    const sendAt = futureSendAt(2);
    const bindings = { ...env, MONTHLY_LIMIT: "1" };
    const created = await call(postReminders(user.cookie, { text: "あ", sendAt }), bindings);
    expect(created.status).toBe(201);
    const id = (await readCreated(created)).data.reminder.id;
    const deleted = await call(deleteReminders(user.cookie, id), bindings);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true, data: { ok: true }, error: null });
    expect(await reminderById(id)).toBeNull();
    const again = await call(postReminders(user.cookie, { text: "い", sendAt }), bindings);
    expect(again.status).toBe(201);
  });

  it("過去の scheduled も取り消せる", async () => {
    const user = await createUser("active");
    const id = crypto.randomUUID();
    await insertReminder(id, user.id, "scheduled", "2020-01-01T00:00:00Z", "2020-01");
    const response = await call(deleteReminders(user.cookie, id));
    expect(response.status).toBe(200);
    expect(await reminderById(id)).toBeNull();
  });

  it("他人の scheduled は 404 で、自分の一覧にも出ない", async () => {
    const owner = await createUser("active");
    const stranger = await createUser("active");
    const id = crypto.randomUUID();
    await insertReminder(id, owner.id, "scheduled", "2026-12-01T00:00:00Z", "2026-12");
    const response = await call(deleteReminders(stranger.cookie, id));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFound);
    expect((await reminderById(id))?.status).toBe("scheduled");
    const upcoming = await readList(await call(getReminders(stranger.cookie, "upcoming")));
    expect(upcoming.data.reminders.map((item) => item.id)).not.toContain(id);
  });

  it("自分の sending は 404 で sending のまま", async () => {
    const user = await createUser("active");
    const id = crypto.randomUUID();
    await insertReminder(id, user.id, "sending", "2026-12-01T00:05:00Z", "2026-12");
    const response = await call(deleteReminders(user.cookie, id));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFound);
    expect((await reminderById(id))?.status).toBe("sending");
  });

  it("sent と failed は 404 で残る", async () => {
    const user = await createUser("active");
    const sent = crypto.randomUUID();
    const failed = crypto.randomUUID();
    await insertReminder(sent, user.id, "sent", "2026-12-01T00:06:00Z", "2026-12");
    await insertReminder(failed, user.id, "failed", "2026-12-01T00:07:00Z", "2026-12");
    for (const id of [sent, failed]) {
      const response = await call(deleteReminders(user.cookie, id));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(notFound);
      expect(await reminderById(id)).not.toBeNull();
    }
  });

  it("無い id も形の違う id も、他人のときと同じ 404", async () => {
    const user = await createUser("active");
    const missing = await call(deleteReminders(user.cookie, crypto.randomUUID()));
    const malformed = await call(deleteReminders(user.cookie, "not-a-uuid"));
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await missing.json()).toEqual(notFound);
    expect(await malformed.json()).toEqual(notFound);
  });

  it("DELETE の Origin が無いと 403 で行も Cookie も残る", async () => {
    const user = await createUser("active");
    const id = crypto.randomUUID();
    await insertReminder(id, user.id, "scheduled", "2026-12-01T00:08:00Z", "2026-12");
    const response = await call(deleteReminders(user.cookie, id, { origin: false }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(forbiddenRequest);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await reminderById(id))?.status).toBe("scheduled");
  });
});
