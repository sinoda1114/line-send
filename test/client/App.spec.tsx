import "./browser";
import { MantineProvider } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import liff from "@line/liff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";

vi.mock("@line/liff", () => ({
  default: {
    init: vi.fn(),
    isInClient: vi.fn(),
    isLoggedIn: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getIDToken: vi.fn(),
    getFriendship: vi.fn(),
    requestFriendship: vi.fn(),
  },
}));

const TEST_LIFF_ID = "1234567890-testLiff";

const activeUser = {
  id: "user-1",
  displayName: "太郎",
  status: "active" as const,
  isAdmin: false,
};

const usage = { month: "2026-10", count: 2, limit: 30 };

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
  return json({ success: false, data: null, error: { code: "UNAUTHORIZED", message } }, status);
}

function installFetch(
  route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("api.line.me")) {
      throw new Error("LINE API を呼びました");
    }
    return route(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(liffId: string) {
  return render(
    <MantineProvider>
      <DatesProvider settings={{ locale: "ja" }}>
        <App liffId={liffId} />
      </DatesProvider>
    </MantineProvider>,
  );
}

function callsInclude(fetchMock: ReturnType<typeof installFetch>, part: string): boolean {
  return fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes(part));
}

beforeEach(() => {
  vi.mocked(liff.init).mockReset();
  vi.mocked(liff.init).mockResolvedValue(undefined);
  vi.mocked(liff.isInClient).mockReset();
  vi.mocked(liff.isInClient).mockReturnValue(false);
  vi.mocked(liff.isLoggedIn).mockReset();
  vi.mocked(liff.isLoggedIn).mockReturnValue(true);
  vi.mocked(liff.login).mockReset();
  vi.mocked(liff.logout).mockReset();
  vi.mocked(liff.getIDToken).mockReset();
  vi.mocked(liff.getIDToken).mockReturnValue("fake-id-token");
  vi.mocked(liff.getFriendship).mockReset();
  vi.mocked(liff.getFriendship).mockResolvedValue({ friendFlag: true });
  vi.mocked(liff.requestFriendship).mockReset();
  vi.mocked(liff.requestFriendship).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("LIFF ID が未設定なら案内だけを出す", async () => {
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp("");
    expect(await screen.findByText("LIFF ID が未設定です")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(liff.init).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ログインしてセッションを作る", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "予約する" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "管理" })).toBeNull();
    expect(liff.init).toHaveBeenCalledWith({ liffId: TEST_LIFF_ID });
    const sessionCall = fetchMock.mock.calls[0];
    const sessionInit = sessionCall?.[1];
    expect(requestUrl(sessionCall?.[0] ?? "")).toBe("/api/session");
    expect(requestUrl(sessionCall?.[0] ?? "").includes("fake-id-token")).toBe(false);
    expect(sessionInit?.method).toBe("POST");
    expect(sessionInit?.credentials).toBe("same-origin");
    expect(header(sessionInit, "Content-Type")).toBe("application/json");
    expect(header(sessionInit, "Origin")).toBeNull();
    expect(JSON.parse(String(sessionInit?.body))).toEqual({ idToken: "fake-id-token" });
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] ?? "")).toBe("/api/me");
    expect(screen.queryByText("公式アカウントを友だち追加してください")).toBeNull();
  });

  it("外部ブラウザではログインへ移る", async () => {
    vi.mocked(liff.isLoggedIn).mockReturnValue(false);
    vi.mocked(liff.isInClient).mockReturnValue(false);
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインしています")).toBeTruthy();
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledWith();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("LIFF ブラウザで未ログインならログインを呼ばない", async () => {
    vi.mocked(liff.isLoggedIn).mockReturnValue(false);
    vi.mocked(liff.isInClient).mockReturnValue(true);
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインできません")).toBeTruthy();
    expect(liff.login).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ID トークンが無いときは API を呼ばない", async () => {
    vi.mocked(liff.getIDToken).mockReturnValue(null);
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインできません")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ID トークンが空のときも API を呼ばない", async () => {
    vi.mocked(liff.getIDToken).mockReturnValue("");
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインできません")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("セッション失敗の文言を出す", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/session") {
        return failure(401, "ログインできません");
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインできません")).toBeTruthy();
    expect(callsInclude(fetchMock, "/api/reminders")).toBe(false);
  });

  it("初期化に失敗したらログインできません", async () => {
    vi.mocked(liff.init).mockRejectedValue(new Error("init"));
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("ログインできません")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("利用者の取得に失敗したらその文言を出す", async () => {
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return failure(401, "利用者を確認できません");
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("利用者を確認できません")).toBeTruthy();
  });

  it("申請中は予約も管理も出さず、退会は出す", async () => {
    const fetchMock = installFetch((url) => {
      const user = { ...activeUser, status: "pending" as const };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("承認待ちです")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "予約する" })).toBeNull();
    expect(screen.getByRole("button", { name: "退会" })).toBeTruthy();
    expect(screen.queryByText("管理")).toBeNull();
    expect(callsInclude(fetchMock, "/api/reminders")).toBe(false);
  });

  it("却下では利用できない", async () => {
    installFetch((url) => {
      const user = { ...activeUser, status: "rejected" as const };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("利用できません")).toBeTruthy();
    expect(screen.queryByText("退会")).toBeNull();
    expect(screen.queryByText("管理")).toBeNull();
    expect(screen.queryByRole("button", { name: "予約する" })).toBeNull();
  });

  it("承認済みの非管理者は確認のあと退会する", async () => {
    const fetchMock = installFetch((url, init) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me" && init?.method === "DELETE") {
        return ok({ ok: true });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    fireEvent.click(await screen.findByRole("button", { name: "退会" }));
    fireEvent.click(screen.getByRole("button", { name: "退会する" }));
    expect(await screen.findByText("退会しました")).toBeTruthy();
    expect(screen.queryByText("ログアウトしました")).toBeNull();
    expect(liff.logout).toHaveBeenCalledTimes(1);
    const deleteCall = fetchMock.mock.calls.find(
      (call) => requestUrl(call[0]) === "/api/me" && call[1]?.method === "DELETE",
    );
    expect(deleteCall?.[1]?.body).toBe("{}");
    expect(deleteCall?.[1]?.credentials).toBe("same-origin");
    expect(header(deleteCall?.[1], "Content-Type")).toBe("application/json");
    expect(header(deleteCall?.[1], "Origin")).toBeNull();
    expect(callsInclude(fetchMock, "/api/session")).toBe(true);
    expect(fetchMock.mock.calls.filter((call) => requestUrl(call[0]) === "/api/session")).toHaveLength(
      1,
    );
  });

  it("退会が拒否されたら画面も LIFF も切らない", async () => {
    installFetch((url, init) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me" && init?.method === "DELETE") {
        return failure(403, "退会できません");
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    fireEvent.click(await screen.findByRole("button", { name: "退会" }));
    fireEvent.click(screen.getByRole("button", { name: "退会する" }));
    expect(await screen.findByText("退会できません")).toBeTruthy();
    expect(liff.logout).not.toHaveBeenCalled();
    expect(screen.queryByText("退会しました")).toBeNull();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
  });

  it("管理者でも予約画面のままである", async () => {
    const fetchMock = installFetch((url) => {
      const user = { ...activeUser, isAdmin: true };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "予約する" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "管理" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "退会" })).toBeNull();
    expect(screen.queryByRole("button", { name: "太郎を承認" })).toBeNull();
    expect(callsInclude(fetchMock, "/api/admin")).toBe(false);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "予約",
      "管理",
      "送信待ち",
      "履歴",
    ]);
  });

  it("管理者は管理タブで承認し、失敗は案内に出す", async () => {
    const pending = {
      id: "user/1",
      displayName: "太郎",
      status: "pending" as const,
      monthCount: 0,
    };
    const other = {
      id: "user-2",
      displayName: "花子",
      status: "active" as const,
      monthCount: 1,
    };
    let users = [pending, other];
    const fetchMock = installFetch((url, init) => {
      const user = { ...activeUser, isAdmin: true };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      if (url === "/api/admin/users" && init?.method === "GET") {
        return ok({
          users,
          activeCount: 1,
          monthlyLimit: 30,
          globalLimit: 180,
        });
      }
      if (url === "/api/admin/users/user%2F1/approve" && init?.method === "POST") {
        users = [{ ...pending, status: "active" }, other];
        return ok({ ok: true });
      }
      if (url === "/api/admin/users/user-2/reject" && init?.method === "POST") {
        return failure(403, "管理者は却下できません");
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    fireEvent.click(await screen.findByRole("tab", { name: "管理" }));
    expect(await screen.findByText("申請中")).toBeTruthy();
    expect(
      screen.getByText("承認後の人数 × 月間上限が 180 を超える承認はできません"),
    ).toBeTruthy();
    const listCall = fetchMock.mock.calls.find(
      (call) => requestUrl(call[0]) === "/api/admin/users",
    );
    expect(listCall?.[1]?.method).toBe("GET");
    expect(listCall?.[1]?.credentials).toBe("same-origin");
    expect(header(listCall?.[1], "Origin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "太郎を承認" }));
    await waitFor(() => {
      expect(screen.queryByText("申請中")).toBeNull();
    });
    const approveCall = fetchMock.mock.calls.find((call) =>
      requestUrl(call[0]).endsWith("/approve"),
    );
    expect(requestUrl(approveCall?.[0] ?? "")).toBe("/api/admin/users/user%2F1/approve");
    expect(approveCall?.[1]?.method).toBe("POST");
    expect(approveCall?.[1]?.credentials).toBe("same-origin");
    expect(header(approveCall?.[1], "Content-Type")).toBe("application/json");
    expect(header(approveCall?.[1], "Origin")).toBeNull();
    expect(JSON.parse(String(approveCall?.[1]?.body))).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "花子を却下" }));
    expect(await screen.findByText("管理者は却下できません")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "予約" })).toBeTruthy();
  });

  it("一覧の取り直しは、その後の失敗案内を消さない", async () => {
    const pending = {
      id: "user/1",
      displayName: "太郎",
      status: "pending" as const,
      monthCount: 0,
    };
    const other = {
      id: "user-2",
      displayName: "花子",
      status: "active" as const,
      monthCount: 1,
    };
    const listed = {
      users: [pending, other],
      activeCount: 1,
      monthlyLimit: 30,
      globalLimit: 180,
    };
    let listRound = 0;
    let releaseReload: ((response: Response) => void) | null = null;
    installFetch((url, init) => {
      const user = { ...activeUser, isAdmin: true };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      if (url === "/api/admin/users" && init?.method === "GET") {
        listRound += 1;
        if (listRound === 1) {
          return ok(listed);
        }
        return new Promise((resolve) => {
          releaseReload = resolve;
        });
      }
      if (url === "/api/admin/users/user%2F1/approve" && init?.method === "POST") {
        return ok({ ok: true });
      }
      if (url === "/api/admin/users/user-2/reject" && init?.method === "POST") {
        return failure(403, "管理者は却下できません");
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    fireEvent.click(await screen.findByRole("tab", { name: "管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "太郎を承認" }));
    await waitFor(() => {
      expect(listRound).toBe(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "花子を却下" }));
    expect(await screen.findByText("管理者は却下できません")).toBeTruthy();
    await act(async () => {
      releaseReload?.(ok(listed));
    });
    expect(screen.getByText("管理者は却下できません")).toBeTruthy();
  });

  it("管理の一覧に失敗したらその文言を出す", async () => {
    installFetch((url) => {
      const user = { ...activeUser, isAdmin: true };
      if (url === "/api/session") {
        return ok({ user });
      }
      if (url === "/api/me") {
        return ok({ user, usage });
      }
      if (url.startsWith("/api/reminders")) {
        return ok({ reminders: [] });
      }
      if (url === "/api/admin/users") {
        return failure(403, "管理できません");
      }
      return failure(500, "通信できません");
    });
    renderApp(TEST_LIFF_ID);
    fireEvent.click(await screen.findByRole("tab", { name: "管理" }));
    expect(await screen.findByText("管理できません")).toBeTruthy();
  });

  it("未友だちなら追加を案内し、予約は止めない", async () => {
    vi.mocked(liff.getFriendship).mockResolvedValue({ friendFlag: false });
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("公式アカウントを友だち追加してください")).toBeTruthy();
    const reserve = screen.getByRole("button", { name: "予約する" }) as HTMLButtonElement;
    expect(reserve.disabled).toBe(false);
    screen.getByRole("button", { name: "友だち追加" }).click();
    await waitFor(() => {
      expect(liff.requestFriendship).toHaveBeenCalledTimes(1);
    });
    expect(liff.requestFriendship).toHaveBeenCalledWith();
  });

  it("友だち追加に失敗しても案内を残す", async () => {
    vi.mocked(liff.getFriendship).mockResolvedValue({ friendFlag: false });
    vi.mocked(liff.requestFriendship).mockRejectedValue(new Error("friend"));
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("公式アカウントを友だち追加してください")).toBeTruthy();
    screen.getByRole("button", { name: "友だち追加" }).click();
    await waitFor(() => {
      expect(liff.requestFriendship).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("公式アカウントを友だち追加してください")).toBeTruthy();
  });

  it("遅い友だち確認は、後から付いた結果を消さない", async () => {
    let releaseSlow: ((value: { friendFlag: boolean }) => void) | undefined;
    vi.mocked(liff.getFriendship)
      .mockResolvedValueOnce({ friendFlag: false })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({ friendFlag: true });
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("公式アカウントを友だち追加してください")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "友だち追加" }));
    await waitFor(() => {
      expect(liff.getFriendship).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "友だち追加" }));
    await waitFor(() => {
      expect(screen.queryByText("公式アカウントを友だち追加してください")).toBeNull();
    });
    await act(async () => {
      releaseSlow?.({ friendFlag: false });
    });
    expect(screen.queryByText("公式アカウントを友だち追加してください")).toBeNull();
    expect(liff.requestFriendship).toHaveBeenCalledTimes(2);
  });

  it("友だち追加のあとフラグが true なら案内を消す", async () => {
    vi.mocked(liff.getFriendship)
      .mockResolvedValueOnce({ friendFlag: false })
      .mockResolvedValueOnce({ friendFlag: true });
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByText("公式アカウントを友だち追加してください")).toBeTruthy();
    screen.getByRole("button", { name: "友だち追加" }).click();
    await waitFor(() => {
      expect(screen.queryByText("公式アカウントを友だち追加してください")).toBeNull();
    });
  });

  it("友だち状態が取れなくても予約画面を出す", async () => {
    vi.mocked(liff.getFriendship).mockRejectedValue(new Error("no official account"));
    installFetch((url) => {
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "予約する" })).toBeTruthy();
    expect(screen.queryByText("公式アカウントを友だち追加してください")).toBeNull();
  });

  it("ログアウトが成功したときだけ LIFF も切る", async () => {
    installFetch((url, init) => {
      if (url === "/api/session" && init?.method === "DELETE") {
        return ok({ ok: true });
      }
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "ログアウト" })).toBeTruthy();
    screen.getByRole("button", { name: "ログアウト" }).click();
    expect(await screen.findByText("ログアウトしました")).toBeTruthy();
    expect(liff.logout).toHaveBeenCalledTimes(1);
  });

  it("ログアウトが拒否されたら LIFF は切らない", async () => {
    installFetch((url, init) => {
      if (url === "/api/session" && init?.method === "DELETE") {
        return failure(403, "ログアウトできません");
      }
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "ログアウト" })).toBeTruthy();
    screen.getByRole("button", { name: "ログアウト" }).click();
    expect(await screen.findByText("ログアウトできません")).toBeTruthy();
    expect(liff.logout).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
  });

  it("ログアウト後のログインは外部ブラウザだけ進む", async () => {
    installFetch((url, init) => {
      if (url === "/api/session" && init?.method === "DELETE") {
        return ok({ ok: true });
      }
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "ログアウト" })).toBeTruthy();
    screen.getByRole("button", { name: "ログアウト" }).click();
    expect(await screen.findByRole("button", { name: "ログイン" })).toBeTruthy();
    vi.mocked(liff.isInClient).mockReturnValue(false);
    screen.getByRole("button", { name: "ログイン" }).click();
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledWith();
  });

  it("ログアウト後に LIFF ブラウザならログインを呼ばない", async () => {
    installFetch((url, init) => {
      if (url === "/api/session" && init?.method === "DELETE") {
        return ok({ ok: true });
      }
      if (url === "/api/session") {
        return ok({ user: activeUser });
      }
      if (url === "/api/me") {
        return ok({ user: activeUser, usage });
      }
      return ok({ reminders: [] });
    });
    renderApp(TEST_LIFF_ID);
    expect(await screen.findByRole("button", { name: "ログアウト" })).toBeTruthy();
    screen.getByRole("button", { name: "ログアウト" }).click();
    expect(await screen.findByRole("button", { name: "ログイン" })).toBeTruthy();
    vi.mocked(liff.isInClient).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    expect(liff.login).not.toHaveBeenCalled();
    expect(await screen.findByText("ログインできません")).toBeTruthy();
  });

  it("初期化の完了前に外したら結果を捨てる", async () => {
    let resolveInit: (() => void) | undefined;
    vi.mocked(liff.init).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInit = () => {
            resolve();
          };
        }),
    );
    const fetchMock = installFetch(() => failure(500, "通信できません"));
    const view = renderApp(TEST_LIFF_ID);
    view.unmount();
    resolveInit?.();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
