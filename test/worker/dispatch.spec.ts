import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { dispatch } from "../../src/worker/services/dispatch";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const at0300 = "2026-10-10T03:00:00Z";
const at0301 = "2026-10-10T03:01:00Z";
const at0302 = "2026-10-10T03:02:00Z";

const userId = "11111111-1111-4111-8111-111111111111";
const lineUserId = "U11111111111111111111111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const otherLineUserId = "U22222222222222222222222222222222";

const originalFetch = globalThis.fetch;

type PushCall = {
  url: string;
  authorization: string | null;
  retryKey: string | null;
  body: unknown;
};

type SavedReminder = {
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  updated_at: string;
};

function installFetch(
  respond: (request: Request) => Response | Promise<Response>,
): PushCall[] {
  const calls: PushCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== LINE_PUSH_URL) {
      throw new Error("unexpected url");
    }
    if (request.method !== "POST" || request.redirect !== "manual") {
      throw new Error("unexpected request");
    }
    if (request.headers.get("content-type") !== "application/json") {
      throw new Error("unexpected content-type");
    }
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      retryKey: request.headers.get("x-line-retry-key"),
      body: await request.json(),
    });
    return await respond(request);
  };
  return calls;
}

function mockPush(status: number, body: unknown): PushCall[] {
  return installFetch(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function mockRaw(status: number, raw: string): PushCall[] {
  return installFetch(
    () =>
      new Response(raw, {
        status,
        headers: { "content-type": "text/plain" },
      }),
  );
}

function mockNetwork(): PushCall[] {
  return installFetch(() => {
    throw new TypeError("network");
  });
}

function expectPush(
  call: PushCall | undefined,
  id: string,
  text: string,
  to = lineUserId,
): void {
  expect(call).toMatchObject({
    url: LINE_PUSH_URL,
    authorization: "Bearer test-token",
    retryKey: id,
    body: { to, messages: [{ type: "text", text }] },
  });
}

async function runAt(iso: string): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({
      scheduledTime: new Date(iso),
      cron: "* * * * *",
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

async function insertUser(
  id: string,
  lineId: string,
  status: "pending" | "active" | "rejected",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, line_user_id, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, lineId, "テスト", status, "2026-10-10T00:00:00.000Z")
    .run();
}

async function insertReminder(input: {
  id: string;
  userId: string;
  text: string;
  sendAt: string;
  status: "scheduled" | "sending";
  updatedAt: string;
  attempts?: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO reminders (id, user_id, text, send_at, send_month, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.id,
      input.userId,
      input.text,
      input.sendAt,
      "2026-10",
      input.status,
      input.attempts ?? 0,
      "2026-10-10T00:00:00.000Z",
      input.updatedAt,
    )
    .run();
}

async function readReminder(id: string): Promise<SavedReminder> {
  const row = await env.DB.prepare(
    "SELECT status, attempts, last_error, sent_at, updated_at FROM reminders WHERE id = ?",
  )
    .bind(id)
    .first<SavedReminder>();
  if (!row) {
    throw new Error("reminder missing");
  }
  return row;
}

async function seedActive(id: string, text: string, sendAt: string): Promise<void> {
  await insertReminder({
    id,
    userId,
    text,
    sendAt,
    status: "scheduled",
    updatedAt: "2026-10-10T01:00:00Z",
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("送信処理", () => {
  it("due を1件送って sent にする", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const calls = mockPush(200, { sentMessages: [{ id: "1", quoteToken: "q" }] });

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 1,
      sent_at: at0300,
      last_error: null,
    });
  });

  it("同じ分の2件のうち早い方だけ送る", async () => {
    await insertUser(userId, lineUserId, "active");
    const early = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const late = "00000000-0000-4000-8000-000000000001";
    await seedActive(early, "早い文面", "2026-10-10T02:00:00Z");
    await seedActive(late, "遅い文面", "2026-10-10T02:30:00Z");
    const calls = mockPush(200, { sentMessages: [{ id: "1", quoteToken: "q" }] });

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], early, "早い文面");
    expect(await readReminder(early)).toMatchObject({
      status: "sent",
      sent_at: at0300,
    });
    expect(await readReminder(late)).toMatchObject({
      status: "scheduled",
      attempts: 0,
      sent_at: null,
    });
  });

  it("5分前の sending を同じ Retry Key で sent にする", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
    await insertReminder({
      id,
      userId,
      text: "再送文面",
      sendAt: "2026-10-10T02:00:00Z",
      status: "sending",
      updatedAt: "2026-10-10T02:55:00Z",
      attempts: 1,
    });
    const calls = mockPush(409, {});

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], id, "再送文面");
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 2,
      sent_at: at0300,
    });
  });

  it("送信中の方が早ければ送信中だけ送る", async () => {
    await insertUser(userId, lineUserId, "active");
    const dueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
    const staleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
    await seedActive(dueId, "待ち文面", "2026-10-10T02:55:00Z");
    await insertReminder({
      id: staleId,
      userId,
      text: "途中文面",
      sendAt: "2026-10-10T02:00:00Z",
      status: "sending",
      updatedAt: "2026-10-10T02:50:00Z",
      attempts: 1,
    });
    const calls = mockPush(200, {});

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], staleId, "途中文面");
    expect(await readReminder(staleId)).toMatchObject({ status: "sent" });
    expect(await readReminder(dueId)).toMatchObject({
      status: "scheduled",
      attempts: 0,
    });
  });

  it("同じ時刻なら送信待ちを送る", async () => {
    await insertUser(userId, lineUserId, "active");
    const dueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6";
    const staleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7";
    await seedActive(dueId, "待ち文面", "2026-10-10T02:55:00Z");
    await insertReminder({
      id: staleId,
      userId,
      text: "途中文面",
      sendAt: "2026-10-10T02:00:00Z",
      status: "sending",
      updatedAt: "2026-10-10T02:55:00Z",
      attempts: 1,
    });
    const calls = mockPush(200, {});

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], dueId, "待ち文面");
    expect(await readReminder(dueId)).toMatchObject({ status: "sent" });
    expect(await readReminder(staleId)).toMatchObject({
      status: "sending",
      attempts: 1,
    });
  });

  it("500 のあと次の分で sent にする", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const first = mockPush(500, { message: "internal error body" });

    await runAt(at0300);

    expect(first).toHaveLength(1);
    expectPush(first[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      last_error: null,
      sent_at: null,
    });

    const second = mockPush(200, { sentMessages: [{ id: "1", quoteToken: "q" }] });
    await runAt(at0301);

    expect(second).toHaveLength(1);
    expectPush(second[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 2,
      sent_at: at0301,
    });
  });

  it("通信エラーのあと次の分で sent にする", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const first = mockNetwork();

    await runAt(at0300);

    expect(first).toHaveLength(1);
    expectPush(first[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      last_error: null,
    });

    const second = mockPush(200, {});
    await runAt(at0301);

    expect(second).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 2,
      sent_at: at0301,
    });
  });

  it("リダイレクトは再送する", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const calls = mockRaw(302, "");

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      last_error: null,
    });
  });

  it("400 はその場で failed になり次は送らない", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const first = mockPush(400, { message: "Invalid request" });

    await runAt(at0300);

    expect(first).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "http_400",
      sent_at: null,
    });

    const second = mockPush(200, {});
    await runAt(at0301);
    expect(second).toHaveLength(0);
    expect(await readReminder(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "http_400",
    });
  });

  it("500 が3回で failed になる", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");

    const first = mockPush(500, { message: "down" });
    await runAt(at0300);
    expect(first).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
    });

    const second = mockPush(500, { message: "down" });
    await runAt(at0301);
    expect(second).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 2,
    });

    const third = mockPush(500, { message: "down" });
    await runAt(at0302);
    expect(third).toHaveLength(1);
    expectPush(third[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "failed",
      attempts: 3,
      last_error: "http_5xx",
    });
  });

  it("同じ scheduled を2回起動しても push は1回", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const calls = mockPush(200, { sentMessages: [{ id: "1", quoteToken: "q" }] });
    const scheduledTime = new Date(at0300);
    const first = createExecutionContext();
    const second = createExecutionContext();

    await Promise.all([
      worker.scheduled(
        createScheduledController({ scheduledTime, cron: "* * * * *" }),
        env,
        first,
      ),
      worker.scheduled(
        createScheduledController({ scheduledTime, cron: "* * * * *" }),
        env,
        second,
      ),
    ]);
    await waitOnExecutionContext(first);
    await waitOnExecutionContext(second);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 1,
      sent_at: at0300,
    });
  });

  it("4分前の sending は送らない", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
    await insertReminder({
      id,
      userId,
      text: "文面",
      sendAt: "2026-10-10T02:00:00Z",
      status: "sending",
      updatedAt: "2026-10-10T02:56:00Z",
      attempts: 1,
    });
    const calls = mockPush(200, {});

    await runAt(at0300);

    expect(calls).toHaveLength(0);
    expect(await readReminder(id)).toMatchObject({
      status: "sending",
      attempts: 1,
      updated_at: "2026-10-10T02:56:00Z",
    });
  });

  it("401 は attempts を戻して2件目を送らない", async () => {
    await insertUser(userId, lineUserId, "active");
    const early = "ffffffff-ffff-4fff-8fff-ffffffffff01";
    const late = "00000000-0000-4000-8000-000000000002";
    await seedActive(early, "早い文面", "2026-10-10T02:00:00Z");
    await seedActive(late, "遅い文面", "2026-10-10T02:30:00Z");
    const calls = mockPush(401, {
      message:
        "Authentication failed due to the following reason: invalid token",
    });

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], early, "早い文面");
    expect(await readReminder(early)).toMatchObject({
      status: "scheduled",
      attempts: 0,
      updated_at: "2026-10-10T01:00:00Z",
      last_error: null,
    });
    expect(await readReminder(late)).toMatchObject({
      status: "scheduled",
      attempts: 0,
      updated_at: "2026-10-10T01:00:00Z",
    });
  });

  it("月間上限の 429 は attempts を戻して2件目を送らない", async () => {
    await insertUser(userId, lineUserId, "active");
    const early = "ffffffff-ffff-4fff-8fff-ffffffffff02";
    const late = "00000000-0000-4000-8000-000000000003";
    await seedActive(early, "早い文面", "2026-10-10T02:00:00Z");
    await seedActive(late, "遅い文面", "2026-10-10T02:30:00Z");
    const calls = mockPush(429, {
      message: "You have reached your monthly limit.",
    });

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expectPush(calls[0], early, "早い文面");
    expect(await readReminder(early)).toMatchObject({
      status: "scheduled",
      attempts: 0,
      updated_at: "2026-10-10T01:00:00Z",
      last_error: null,
    });
    expect(await readReminder(late)).toMatchObject({
      status: "scheduled",
      attempts: 0,
    });
  });

  it("レート制限の 429 は次の分で sent にする", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const first = mockPush(429, {
      message: "The API rate limit has been exceeded. Try again later.",
    });

    await runAt(at0300);

    expect(first).toHaveLength(1);
    expectPush(first[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      last_error: null,
    });

    const second = mockPush(200, {});
    await runAt(at0301);
    expect(second).toHaveLength(1);
    expectPush(second[0], id, "文面");
    expect(await readReminder(id)).toMatchObject({
      status: "sent",
      attempts: 2,
      sent_at: at0301,
    });
  });

  it.each([
    ["JSON でない", "not-json"],
    ["null", "null"],
    ["message が無い", "{}"],
    ["message が文字列でない", '{"message":1}'],
  ])("429 の本文が月間上限でなければ再送する（%s）", async (_label, raw) => {
    await insertUser(userId, lineUserId, "active");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const calls = mockRaw(429, raw);

    await runAt(at0300);

    expect(calls).toHaveLength(1);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      last_error: null,
    });
  });

  it("pending の due は送らない", async () => {
    await insertUser(otherUserId, otherLineUserId, "pending");
    const id = "99999999-9999-4999-8999-999999999991";
    await insertReminder({
      id,
      userId: otherUserId,
      text: "文面",
      sendAt: "2026-10-10T02:00:00Z",
      status: "scheduled",
      updatedAt: "2026-10-10T01:00:00Z",
    });
    const calls = mockPush(200, {});

    await runAt(at0300);

    expect(calls).toHaveLength(0);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 0,
    });
  });

  it("空のトークンでは送らず行も変えない", async () => {
    await insertUser(userId, lineUserId, "active");
    const id = "99999999-9999-4999-8999-999999999992";
    await seedActive(id, "文面", "2026-10-10T02:00:00Z");
    const calls = mockPush(200, {});

    await dispatch(env.DB, "", Date.parse(at0300));

    expect(calls).toHaveLength(0);
    expect(await readReminder(id)).toMatchObject({
      status: "scheduled",
      attempts: 0,
      updated_at: "2026-10-10T01:00:00Z",
      sent_at: null,
    });
  });
});
