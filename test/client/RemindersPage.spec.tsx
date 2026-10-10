import "./browser";
import { MantineProvider } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, Reminder } from "../../src/client/api";
import { RemindersPage } from "../../src/client/pages/RemindersPage";

const NOW = Date.parse("2026-10-10T03:00:30.000Z");

const me: Me = {
  user: {
    id: "user-1",
    displayName: "太郎",
    status: "active",
    isAdmin: false,
  },
  usage: { month: "2026-10", count: 2, limit: 30 },
};

const scheduled: Reminder = {
  id: "rem-1",
  text: "牛乳",
  sendAt: "2026-10-31T15:30:00Z",
  sendMonth: "2026-11",
  status: "scheduled",
  sentAt: null,
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const value = headers[name] ?? headers[name.toLowerCase()];
  return value ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(data: unknown, status = 200): Response {
  return json({ success: true, data, error: null }, status);
}

function failure(status: number, message: string): Response {
  return json({ success: false, data: null, error: { code: "QUOTA_EXCEEDED", message } }, status);
}

function renderPage(props: { initialSendAt?: string; onMe?: (next: Me) => void } = {}) {
  return render(
    <MantineProvider>
      <DatesProvider settings={{ locale: "ja" }}>
        <RemindersPage me={me} initialSendAt={props.initialSendAt} onMe={props.onMe ?? vi.fn()} />
      </DatesProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RemindersPage", () => {
  it("取り消しは JSON の空オブジェクトで送り、一覧から消す", async () => {
    let upcoming: Reminder[] = [scheduled];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("api.line.me")) {
        throw new Error("LINE API を呼びました");
      }
      if (url === "/api/reminders/rem-1" && init?.method === "DELETE") {
        upcoming = [];
        return ok({ ok: true });
      }
      if (url === "/api/reminders?view=upcoming") {
        return ok({ reminders: upcoming });
      }
      if (url === "/api/reminders?view=history") {
        return ok({ reminders: [] });
      }
      if (url === "/api/me") {
        return ok(me);
      }
      return failure(500, "通信できません");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("送信待ちはありません")).toBeTruthy();
    const deleteCall = fetchMock.mock.calls.find(
      (call) => requestUrl(call[0]) === "/api/reminders/rem-1" && call[1]?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(header(deleteCall?.[1], "Content-Type")).toBe("application/json");
    expect(deleteCall?.[1]?.credentials).toBe("same-origin");
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({});
    expect(header(deleteCall?.[1], "Origin")).toBeNull();
  });

  it("作成は text と sendAt だけを送る", async () => {
    const onMe = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("api.line.me")) {
        throw new Error("LINE API を呼びました");
      }
      if (url === "/api/reminders" && init?.method === "POST") {
        return ok(
          {
            reminder: {
              id: "rem-new",
              text: "あ",
              sendAt: "2026-10-10T03:01:00Z",
              sendMonth: "2026-10",
              status: "scheduled",
              sentAt: null,
            },
          },
          201,
        );
      }
      if (url === "/api/me") {
        return ok({
          ...me,
          usage: { month: "2026-10", count: 3, limit: 30 },
        });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      return failure(500, "通信できません");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage({ initialSendAt: "2026-10-10 12:01:00", onMe });
    expect(await screen.findByText("送信待ちはありません")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("文面"), { target: { value: "  あ  " } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await waitFor(() => {
      expect(onMe).toHaveBeenCalledWith({
        ...me,
        usage: { month: "2026-10", count: 3, limit: 30 },
      });
    });
    const postCall = fetchMock.mock.calls.find(
      (call) => requestUrl(call[0]) === "/api/reminders" && call[1]?.method === "POST",
    );
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ text: "あ", sendAt: "2026-10-10T03:01:00Z" });
    expect(Object.keys(body)).toEqual(["text", "sendAt"]);
    expect(header(postCall?.[1], "Origin")).toBeNull();
  });

  it("作成のあと一覧の再取得に失敗しても、作った予約を残して文面は空にする", async () => {
    let posted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders" && init?.method === "POST") {
          posted = true;
          return ok({
            reminder: {
              id: "rem-new",
              text: "あ",
              sendAt: "2026-10-10T03:01:00Z",
              sendMonth: "2026-10",
              status: "scheduled",
              sentAt: null,
            },
          });
        }
        if (url === "/api/reminders?view=upcoming" && posted) {
          return failure(500, "一覧を取得できません");
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage({ initialSendAt: "2026-10-10 12:01:00" });
    expect(await screen.findByText("送信待ちはありません")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("文面"), { target: { value: "あ" } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeTruthy();
    expect(screen.getByText("一覧を取得できません")).toBeTruthy();
    expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("");
  });

  it("取り消しのあと一覧の再取得に失敗しても行は消す", async () => {
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders/rem-1" && init?.method === "DELETE") {
          deleted = true;
          return ok({ ok: true });
        }
        if (url === "/api/reminders?view=upcoming" && deleted) {
          return failure(500, "一覧を取得できません");
        }
        if (url === "/api/reminders?view=upcoming") {
          return ok({ reminders: [scheduled] });
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage();
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("一覧を取得できません")).toBeTruthy();
    expect(screen.queryByText("牛乳")).toBeNull();
    expect(screen.getByText("送信待ちはありません")).toBeTruthy();
  });

  it("遅い取り消し失敗は、その後の再取得より新しいエラーを戻さない", async () => {
    let releaseDelete: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders/rem-1" && init?.method === "DELETE") {
          await new Promise<void>((resolve) => {
            releaseDelete = resolve;
          });
          return failure(404, "予約が見つかりません");
        }
        if (url === "/api/reminders" && init?.method === "POST") {
          return ok(
            {
              reminder: {
                id: "rem-new",
                text: "パン",
                sendAt: "2026-10-10T03:01:00Z",
                sendMonth: "2026-10",
                status: "scheduled",
                sentAt: null,
              },
            },
            201,
          );
        }
        if (url === "/api/me") {
          return ok(me);
        }
        if (url === "/api/reminders?view=upcoming") {
          return ok({ reminders: [scheduled] });
        }
        return ok({ reminders: [] });
      }),
    );
    renderPage({ initialSendAt: "2026-10-10 12:01:00" });
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    await waitFor(() => {
      expect(releaseDelete).toBeTypeOf("function");
    });
    fireEvent.change(screen.getByLabelText("文面"), { target: { value: "パン" } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("パン")).toBeTruthy();
    releaseDelete?.();
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: "取り消す" }) as HTMLButtonElement[];
      expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
    });
    expect(screen.queryByText("予約が見つかりません")).toBeNull();
    expect(screen.getByText("牛乳")).toBeTruthy();
  });

  it("作成のあと利用者の取得に失敗しても文面は空にする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders" && init?.method === "POST") {
          return ok({
            reminder: {
              id: "rem-new",
              text: "あ",
              sendAt: "2026-10-10T03:01:00Z",
              sendMonth: "2026-10",
              status: "scheduled",
              sentAt: null,
            },
          });
        }
        if (url === "/api/me" && init?.method !== "POST") {
          return failure(401, "利用者を確認できません");
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage({ initialSendAt: "2026-10-10 12:01:00" });
    expect(await screen.findByText("送信待ちはありません")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("文面"), { target: { value: "あ" } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("利用者を確認できません")).toBeTruthy();
    expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("");
  });

  it("作成が上限ならサーバの文言を残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders" && init?.method === "POST") {
          return failure(429, "この月の上限に達しています");
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage({ initialSendAt: "2026-10-10 12:01:00" });
    expect(await screen.findByText("送信待ちはありません")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("文面"), { target: { value: "残す" } });
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("この月の上限に達しています")).toBeTruthy();
    expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("残す");
  });

  it("取り消しに失敗したら行を残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders/rem-1" && init?.method === "DELETE") {
          return failure(404, "予約が見つかりません");
        }
        if (url === "/api/reminders?view=upcoming") {
          return ok({ reminders: [scheduled] });
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage();
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("予約が見つかりません")).toBeTruthy();
    expect(screen.getByText("牛乳")).toBeTruthy();
  });

  it("一覧の取得に失敗したら文言を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === "/api/reminders?view=upcoming") {
          return failure(500, "一覧を取得できません");
        }
        return ok({ reminders: [] });
      }),
    );
    renderPage();
    expect(await screen.findByText("一覧を取得できません")).toBeTruthy();
    expect(screen.queryByText("送信待ちはありません")).toBeNull();
    expect(screen.queryByText("履歴はありません")).toBeNull();
  });

  it("取り消しの通信中はその行だけ押せない", async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "/api/reminders/rem-1" && init?.method === "DELETE") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return ok({ ok: true });
        }
        if (url === "/api/reminders?view=upcoming") {
          return ok({ reminders: [scheduled, { ...scheduled, id: "rem-2", text: "パン" }] });
        }
        if (url.startsWith("/api/reminders")) {
          return ok({ reminders: [] });
        }
        return ok(me);
      }),
    );
    renderPage();
    expect(await screen.findByText("パン")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "取り消す" }) as HTMLButtonElement[];
    fireEvent.click(buttons[0] ?? screen.getByRole("button", { name: "取り消す" }));
    await waitFor(() => {
      const during = screen.getAllByRole("button", { name: "取り消す" }) as HTMLButtonElement[];
      expect(during[0]?.disabled).toBe(true);
      expect(during[1]?.disabled).toBe(false);
    });
    release?.();
    await waitFor(() => {
      const after = screen.getAllByRole("button", { name: "取り消す" }) as HTMLButtonElement[];
      expect(after[0]?.disabled).toBe(false);
    });
  });
});
