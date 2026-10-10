import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { openSession, sealSession } from "../../src/worker/auth/session-cookie";
import worker from "../../src/worker/index";
import { japanYearMonth } from "../../src/shared/time";

const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const ORIGIN = "https://app.example";
const ID_TOKEN = "fake-id-token";
const SESSION_URL = "https://app.example/api/session";
const ME_URL = "https://app.example/api/me";
const SECRET = "0123456789abcdef0123456789abcdef";
const SUB = `U${"c".repeat(32)}`;
const ADMIN_SUB = `U${"a".repeat(32)}`;
const originalFetch = globalThis.fetch;

type PublicUser = {
  id: string;
  displayName: string;
  status: string;
  isAdmin: boolean;
};

type ErrorBody = {
  success: false;
  data: null;
  error: { code: string; message: string };
};

type SessionBody = {
  success: true;
  data: { user: PublicUser };
  error: null;
};

type MeBody = {
  success: true;
  data: {
    user: PublicUser;
    usage: { month: string; count: number; limit: number };
  };
  error: null;
};

type UserRecord = {
  id: string;
  display_name: string;
  status: string;
  decided_at: string | null;
};

function mockVerify(status: number, body: unknown): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== VERIFY_URL || request.method !== "POST") {
      throw new Error("unexpected url");
    }
    state.calls += 1;
    const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    if (params.get("client_id") !== "1234567890") {
      throw new Error("unexpected client_id");
    }
    if (params.get("id_token") !== ID_TOKEN) {
      throw new Error("unexpected id_token");
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return state;
}

function verified(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://access.line.me",
    sub: SUB,
    aud: "1234567890",
    exp: 4102444800,
    iat: 1700000000,
    name: "太郎",
    ...overrides,
  };
}

type RuntimeBindings = {
  [Key in keyof Env]: Env[Key] extends string ? string : Env[Key];
};

async function call(request: Request, bindings: RuntimeBindings = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function loginRequest(options?: {
  url?: string;
  origin?: string;
  contentType?: string;
  body?: string;
  cookie?: string;
  omitOrigin?: boolean;
  omitContentType?: boolean;
}): Request {
  const headers = new Headers();
  if (options?.omitOrigin !== true) {
    headers.set("origin", options?.origin ?? ORIGIN);
  }
  if (options?.omitContentType !== true) {
    headers.set("content-type", options?.contentType ?? "application/json");
  }
  if (options?.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  return new Request(options?.url ?? SESSION_URL, {
    method: "POST",
    headers,
    body: options?.body ?? JSON.stringify({ idToken: ID_TOKEN }),
  });
}

function deleteRequest(cookie: string, omitOrigin = false): Request {
  const headers = new Headers({
    "content-type": "application/json",
    cookie,
  });
  if (!omitOrigin) {
    headers.set("origin", ORIGIN);
  }
  return new Request(SESSION_URL, { method: "DELETE", headers });
}

function meRequest(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request(ME_URL, { headers });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("session="));
  if (cookie === undefined) {
    throw new Error("session cookie");
  }
  return cookie;
}

function cookiePair(setCookie: string): string {
  const pair = setCookie.split(";")[0]?.trim();
  if (pair === undefined || pair.length === 0) {
    throw new Error("cookie pair");
  }
  return pair;
}

function expectIssued(setCookie: string, secure: boolean): void {
  expect(setCookie.startsWith("session=")).toBe(true);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("Max-Age=604800");
  expect(setCookie.toLowerCase()).not.toContain("domain=");
  if (secure) {
    expect(setCookie).toContain("Secure");
    return;
  }
  expect(setCookie).not.toContain("Secure");
}

async function readError(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

async function readSession(response: Response): Promise<SessionBody> {
  return (await response.json()) as SessionBody;
}

async function userByLine(lineUserId: string): Promise<UserRecord | null> {
  return await env.DB.prepare(
    "SELECT id, display_name, status, decided_at FROM users WHERE line_user_id = ?1",
  )
    .bind(lineUserId)
    .first<UserRecord>();
}

async function deleteLine(lineUserId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM users WHERE line_user_id = ?1").bind(lineUserId).run();
}

async function userTotal(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

async function countLine(lineUserId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE line_user_id = ?1",
  )
    .bind(lineUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function insertUser(
  id: string,
  lineUserId: string,
  displayName: string,
  status: "pending" | "active" | "rejected",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, line_user_id, display_name, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, lineUserId, displayName, status, "2026-10-10T00:00:00.000Z")
    .run();
}

async function insertReminder(
  id: string,
  userId: string,
  status: "scheduled" | "sending" | "sent" | "failed",
  sendMonth: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      userId,
      "文面",
      "2026-10-10T00:00:00Z",
      sendMonth,
      status,
      "2026-10-10T00:00:00.000Z",
    )
    .run();
}

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 1) {
    return `${String(year - 1)}-12`;
  }
  return `${String(year)}-${String(monthNumber - 1).padStart(2, "0")}`;
}

describe("session", { concurrent: false }, () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ログインして pending の利用者と Cookie を返す", async () => {
    const seen = mockVerify(200, verified());
    const response = await call(loginRequest());
    expect(response.status).toBe(200);
    const body = await readSession(response);
    expect(body.success).toBe(true);
    expect(body.data.user).toMatchObject({
      displayName: "太郎",
      status: "pending",
      isAdmin: false,
    });
    expect(Object.keys(body.data.user).sort()).toEqual([
      "displayName",
      "id",
      "isAdmin",
      "status",
    ]);
    expect(seen.calls).toBe(1);
    const issued = sessionCookie(response);
    expectIssued(issued, true);
    const row = await userByLine(SUB);
    expect(row).toMatchObject({
      id: body.data.user.id,
      display_name: "太郎",
      status: "pending",
      decided_at: null,
    });
    expect(await countLine(SUB)).toBe(1);
  });

  it("表示名が無い新規利用者は LINEユーザー になる", async () => {
    const sub = `U${"b".repeat(32)}`;
    const profile = verified({ sub });
    delete profile.name;
    mockVerify(200, profile);
    const response = await call(loginRequest());
    expect(response.status).toBe(200);
    const body = await readSession(response);
    expect(body.data.user.displayName).toBe("LINEユーザー");
    expect(body.data.user.status).toBe("pending");
  });

  it("再ログインは表示名と id を変えない", async () => {
    mockVerify(200, verified());
    const first = await readSession(await call(loginRequest()));
    mockVerify(200, verified({ name: "花子" }));
    const second = await readSession(await call(loginRequest()));
    expect(second.data.user.id).toBe(first.data.user.id);
    expect(second.data.user.displayName).toBe("太郎");
    expect(second.data.user.status).toBe("pending");
    expect(await countLine(SUB)).toBe(1);
  });

  it("却下済みの再ログインは rejected のまま", async () => {
    const sub = `U${"d".repeat(32)}`;
    const id = "55555555-5555-4555-8555-555555555551";
    await insertUser(id, sub, "元の名前", "rejected");
    mockVerify(200, verified({ sub, name: "花子" }));
    const response = await call(loginRequest());
    expect(response.status).toBe(200);
    const body = await readSession(response);
    expect(body.data.user).toMatchObject({
      id,
      displayName: "元の名前",
      status: "rejected",
      isAdmin: false,
    });
  });

  it("管理者の初回は active で decided_at は NULL", async () => {
    await deleteLine(ADMIN_SUB);
    expect(env.ADMIN_LINE_USER_ID).toBe(ADMIN_SUB);
    mockVerify(200, verified({ sub: ADMIN_SUB, name: "管理者" }));
    const response = await call(loginRequest());
    expect(response.status).toBe(200);
    const body = await readSession(response);
    expect(body.data.user).toMatchObject({
      displayName: "管理者",
      status: "active",
      isAdmin: true,
    });
    const row = await userByLine(ADMIN_SUB);
    expect(row?.decided_at).toBeNull();
    expect(row?.status).toBe("active");
  });

  it("管理者 ID と1文字違う sub は pending", async () => {
    const sub = `${ADMIN_SUB.slice(0, -1)}b`;
    mockVerify(200, verified({ sub }));
    const body = await readSession(await call(loginRequest()));
    expect(body.data.user).toMatchObject({ status: "pending", isAdmin: false });
  });

  it("管理者 ID が空なら誰も管理者にならない", async () => {
    await deleteLine(ADMIN_SUB);
    mockVerify(200, verified({ sub: ADMIN_SUB }));
    const response = await call(
      loginRequest(),
      { ...env, ADMIN_LINE_USER_ID: "" },
    );
    expect(response.status).toBe(200);
    const body = await readSession(response);
    expect(body.data.user).toMatchObject({ status: "pending", isAdmin: false });
  });

  it("同時作成でも利用者は1人", async () => {
    const sub = `U${"f".repeat(32)}`;
    mockVerify(200, verified({ sub }));
    const [left, right] = await Promise.all([
      call(loginRequest()),
      call(loginRequest()),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const leftBody = await readSession(left);
    const rightBody = await readSession(right);
    expect(leftBody.data.user.id).toBe(rightBody.data.user.id);
    expect(await countLine(sub)).toBe(1);
  });

  it("aud が違うと 401 で利用者も Cookie も作らない", async () => {
    const sub = `U${"9".repeat(32)}`;
    const seen = mockVerify(200, verified({ sub, aud: "999" }));
    const response = await call(loginRequest());
    expect(response.status).toBe(401);
    expect(await readError(response)).toEqual({
      success: false,
      data: null,
      error: { code: "UNAUTHORIZED", message: "ログインできません" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(seen.calls).toBe(1);
    expect(await countLine(sub)).toBe(0);
  });

  it("exp が過去なら利用者を作らない", async () => {
    const sub = `U${"8".repeat(32)}`;
    mockVerify(200, verified({ sub, exp: 1 }));
    const response = await call(loginRequest());
    expect(response.status).toBe(401);
    expect((await readError(response)).error.message).toBe("ログインできません");
    expect(await countLine(sub)).toBe(0);
  });

  it("sub が短いと利用者を作らない", async () => {
    mockVerify(200, verified({ sub: "Ushort" }));
    const response = await call(loginRequest());
    expect(response.status).toBe(401);
    expect(await countLine("Ushort")).toBe(0);
  });

  it("verify が 400 なら 401", async () => {
    const before = await userTotal();
    mockVerify(400, { error_description: "Invalid IdToken." });
    const response = await call(loginRequest());
    expect(response.status).toBe(401);
    expect((await readError(response)).error.message).toBe("ログインできません");
    expect(await userTotal()).toBe(before);
  });

  it("通信エラーは 401", async () => {
    const before = await userTotal();
    globalThis.fetch = () => {
      throw new TypeError("network");
    };
    const response = await call(loginRequest());
    expect(response.status).toBe(401);
    expect(await userTotal()).toBe(before);
  });

  it("チャネル ID が空なら verify を呼ばない", async () => {
    const before = await userTotal();
    const seen = mockVerify(200, verified());
    const response = await call(loginRequest(), { ...env, LINE_LOGIN_CHANNEL_ID: "" });
    expect(response.status).toBe(401);
    expect((await readError(response)).error.message).toBe("ログインできません");
    expect(seen.calls).toBe(0);
    expect(await userTotal()).toBe(before);
  });

  it("秘密が32バイト未満なら 500 で verify しない", async () => {
    const before = await userTotal();
    const seen = mockVerify(200, verified());
    const response = await call(loginRequest(), { ...env, SESSION_SECRET: "short" });
    expect(response.status).toBe(500);
    expect(await readError(response)).toEqual({
      success: false,
      data: null,
      error: { code: "INTERNAL", message: "ログインできません" },
    });
    expect(seen.calls).toBe(0);
    expect(await userTotal()).toBe(before);
    expect(await sealSession("short", "55555555-5555-4555-8555-555555555559", Date.now())).toBeNull();
    expect(await openSession("short", "a.b", Date.now())).toBeNull();
  });

  it("idToken が空、数値、長すぎる、JSON でないときは 400", async () => {
    const before = await userTotal();
    const bodies = [
      JSON.stringify({ idToken: "" }),
      JSON.stringify({ idToken: 1 }),
      JSON.stringify({ idToken: "a".repeat(4097) }),
      "not-json",
    ];
    for (const body of bodies) {
      const seen = mockVerify(200, verified());
      const response = await call(loginRequest({ body }));
      expect(response.status).toBe(400);
      expect(await readError(response)).toEqual({
        success: false,
        data: null,
        error: { code: "INVALID_INPUT", message: "入力が不正です" },
      });
      expect(seen.calls).toBe(0);
    }
    expect(await userTotal()).toBe(before);
  });

  it("Origin か Content-Type が不合格なら 403", async () => {
    const before = await userTotal();
    const requests = [
      loginRequest({ omitOrigin: true }),
      loginRequest({ origin: "https://evil.example" }),
      loginRequest({ origin: "https://app.example/" }),
      loginRequest({ contentType: "text/plain" }),
    ];
    for (const request of requests) {
      const seen = mockVerify(200, verified());
      const response = await call(request);
      expect(response.status).toBe(403);
      expect(await readError(response)).toEqual({
        success: false,
        data: null,
        error: { code: "FORBIDDEN", message: "リクエストを受け付けられません" },
      });
      expect(seen.calls).toBe(0);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await userTotal()).toBe(before);
  });

  it("charset 付きの JSON はログインできる", async () => {
    mockVerify(200, verified());
    const response = await call(
      loginRequest({ contentType: "application/json; charset=utf-8" }),
    );
    expect(response.status).toBe(200);
    expect((await readSession(response)).data.user.displayName).toBe("太郎");
  });

  it("APP_ORIGIN が空なら 403", async () => {
    const before = await userTotal();
    const seen = mockVerify(200, verified());
    const response = await call(loginRequest(), { ...env, APP_ORIGIN: "" });
    expect(response.status).toBe(403);
    expect(seen.calls).toBe(0);
    expect(await userTotal()).toBe(before);
  });

  it("Cookie が無い GET /api/me は 401", async () => {
    const response = await call(meRequest());
    expect(response.status).toBe(401);
    expect(await readError(response)).toEqual({
      success: false,
      data: null,
      error: { code: "UNAUTHORIZED", message: "ログインが必要です" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("GET /api/me は当月の failed 以外を数える", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const user = (await readSession(loggedIn)).data.user;
    const month = japanYearMonth(Date.now());
    const otherUser = "55555555-5555-4555-8555-555555555552";
    await insertUser(otherUser, `U${"e".repeat(32)}`, "他人", "active");
    await insertReminder("44444444-4444-4444-8444-000000000001", user.id, "scheduled", month);
    await insertReminder("44444444-4444-4444-8444-000000000002", user.id, "sending", month);
    await insertReminder("44444444-4444-4444-8444-000000000003", user.id, "sent", month);
    await insertReminder("44444444-4444-4444-8444-000000000004", user.id, "failed", month);
    await insertReminder(
      "44444444-4444-4444-8444-000000000005",
      user.id,
      "scheduled",
      previousMonth(month),
    );
    await insertReminder(
      "44444444-4444-4444-8444-000000000006",
      otherUser,
      "scheduled",
      month,
    );
    const response = await call(meRequest(cookiePair(sessionCookie(loggedIn))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as MeBody;
    expect(body.data.user.id).toBe(user.id);
    expect(body.data.usage.count).toBe(3);
    expect(body.data.usage.limit).toBe(30);
    expect([japanYearMonth(Date.now() - 1000), japanYearMonth(Date.now())]).toContain(
      body.data.usage.month,
    );
  });

  it("MONTHLY_LIMIT は整数ならその値、それ以外は 30", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const cookie = cookiePair(sessionCookie(loggedIn));
    const limited = await call(meRequest(cookie), { ...env, MONTHLY_LIMIT: "15" });
    expect(limited.status).toBe(200);
    expect(((await limited.json()) as MeBody).data.usage.limit).toBe(15);
    const ignored = await call(meRequest(cookie), { ...env, MONTHLY_LIMIT: "nope" });
    expect(((await ignored.json()) as MeBody).data.usage.limit).toBe(30);
  });

  it("署名が違う Cookie は 401", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const user = (await readSession(loggedIn)).data.user;
    const token = cookiePair(sessionCookie(loggedIn)).slice("session=".length);
    const flipped = token.endsWith("A") ? `${token.slice(0, -1)}B` : `${token.slice(0, -1)}A`;
    const tampered = await call(meRequest(`session=${flipped}`));
    expect(tampered.status).toBe(401);
    expect(sessionCookie(tampered)).toContain("Max-Age=0");
    const other = await sealSession(
      "fedcba9876543210fedcba9876543210",
      user.id,
      Date.now(),
    );
    expect(other).not.toBeNull();
    const resigned = await call(meRequest(`session=${other ?? ""}`));
    expect(resigned.status).toBe(401);
    expect((await readError(resigned)).error.message).toBe("ログインが必要です");
  });

  it("期限切れの Cookie は 401", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const user = (await readSession(loggedIn)).data.user;
    const expired = await sealSession(
      SECRET,
      user.id,
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    );
    expect(expired).not.toBeNull();
    const response = await call(meRequest(`session=${expired ?? ""}`));
    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toContain("Max-Age=0");
  });

  it("利用者が無い Cookie は 401", async () => {
    const token = await sealSession(
      SECRET,
      "abcdefab-cdef-4abc-8abc-abcdefabcdef",
      Date.now(),
    );
    expect(token).not.toBeNull();
    const response = await call(meRequest(`session=${token ?? ""}`));
    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toContain("Max-Age=0");
  });

  it("ログアウトは Cookie を消し、古い値は期限内なら有効", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const pair = cookiePair(sessionCookie(loggedIn));
    const response = await call(deleteRequest(pair));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { ok: true },
      error: null,
    });
    const cleared = sessionCookie(response);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("Secure");
    const missing = await call(meRequest());
    expect(missing.status).toBe(401);
    const again = await call(meRequest(pair));
    expect(again.status).toBe(200);
  });

  it("DELETE の CSRF 不合格では Cookie を消さない", async () => {
    mockVerify(200, verified());
    const loggedIn = await call(loginRequest());
    const pair = cookiePair(sessionCookie(loggedIn));
    const response = await call(deleteRequest(pair, true));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    const still = await call(meRequest(pair));
    expect(still.status).toBe(200);
  });

  it("Secure は http://localhost だけ付けない", async () => {
    mockVerify(200, verified());
    const cases = [
      { url: "http://localhost/api/session", secure: false },
      { url: "http://example.com/api/session", secure: true },
      { url: "https://localhost/api/session", secure: true },
      { url: "http://127.0.0.1/api/session", secure: true },
    ];
    for (const item of cases) {
      const response = await call(loginRequest({ url: item.url }));
      expect(response.status).toBe(200);
      expectIssued(sessionCookie(response), item.secure);
    }
  });

  it("空や長すぎる表示名は LINEユーザー になる", async () => {
    const emptySub = `U${"1".repeat(32)}`;
    mockVerify(200, verified({ sub: emptySub, name: "" }));
    const emptyName = await readSession(await call(loginRequest()));
    expect(emptyName.data.user.displayName).toBe("LINEユーザー");

    const longSub = `U${"2".repeat(32)}`;
    mockVerify(200, verified({ sub: longSub, name: "あ".repeat(101) }));
    const longName = await readSession(await call(loginRequest()));
    expect(longName.data.user.displayName).toBe("LINEユーザー");

    const keptSub = `U${"3".repeat(32)}`;
    mockVerify(200, verified({ sub: keptSub, name: "あ".repeat(100) }));
    const kept = await readSession(await call(loginRequest()));
    expect(kept.data.user.displayName).toBe("あ".repeat(100));
  });

  it("aud が数値、exp が小数、JSON でない、本文が大きすぎると 401", async () => {
    const numberSub = `U${"7".repeat(32)}`;
    const fractionSub = `U${"6".repeat(32)}`;
    const seen = mockVerify(200, verified({ sub: numberSub, aud: 1234567890 }));
    expect((await call(loginRequest())).status).toBe(401);
    expect(seen.calls).toBe(1);
    expect(await countLine(numberSub)).toBe(0);

    mockVerify(200, verified({ sub: fractionSub, exp: 4102444800.5 }));
    expect((await call(loginRequest())).status).toBe(401);
    expect(await countLine(fractionSub)).toBe(0);

    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== VERIFY_URL) {
        throw new Error("unexpected url");
      }
      await request.arrayBuffer();
      return new Response("not-json", { status: 200 });
    };
    expect((await call(loginRequest())).status).toBe(401);

    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== VERIFY_URL) {
        throw new Error("unexpected url");
      }
      await request.arrayBuffer();
      return new Response("x".repeat(8193), { status: 200 });
    };
    expect((await call(loginRequest())).status).toBe(401);
    expect(await countLine(numberSub)).toBe(0);
    expect(await countLine(fractionSub)).toBe(0);
  });

  it("壊れたセッション文字列は開けない", async () => {
    const id = "55555555-5555-4555-8555-555555555559";
    const now = Date.now();
    const token = await sealSession(SECRET, id, now);
    expect(token).not.toBeNull();
    const opened = await openSession(SECRET, token ?? "", now);
    expect(opened?.id).toBe(id);
    if (opened === null) {
      throw new Error("opened");
    }
    expect(await openSession(SECRET, token ?? "", opened.exp * 1000)).toBeNull();
    expect(await openSession(SECRET, "nope", now)).toBeNull();
    expect(await openSession(SECRET, "!!!.!!!", now)).toBeNull();
    expect(await openSession(SECRET, "a.b.c", now)).toBeNull();
  });
});
