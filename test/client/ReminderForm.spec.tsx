import "./browser";
import { MantineProvider } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderForm } from "../../src/client/components/ReminderForm";
import type { Failure, Usage } from "../../src/client/api";

const NOW = Date.parse("2026-10-10T03:00:30.000Z");

const usage: Usage = { month: "2026-10", count: 2, limit: 30 };

function renderForm(props: {
  usage?: Usage;
  initialSendAt?: string;
  onCreate: (body: { text: string; sendAt: string }) => Promise<{ ok: true } | Failure>;
}) {
  return render(
    <MantineProvider>
      <DatesProvider settings={{ locale: "ja" }}>
        <ReminderForm
          usage={props.usage ?? usage}
          initialSendAt={props.initialSendAt}
          onCreate={props.onCreate}
        />
      </DatesProvider>
    </MantineProvider>,
  );
}

function typeText(value: string) {
  fireEvent.change(screen.getByLabelText("文面"), { target: { value } });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReminderForm", () => {
  it("今月の残り枠を出す", () => {
    renderForm({ onCreate: vi.fn() });
    expect(screen.getByText("今月 2026-10 の残り 28 件（2 / 30）")).toBeTruthy();
  });

  it("上限を超えても残りは 0 である", () => {
    renderForm({
      usage: { month: "2026-10", count: 31, limit: 30 },
      onCreate: vi.fn(),
    });
    expect(screen.getByText("今月 2026-10 の残り 0 件（31 / 30）")).toBeTruthy();
  });

  it("文面の空白を除いて日本時間を UTC にして渡す", async () => {
    const onCreate = vi.fn<(body: { text: string; sendAt: string }) => Promise<{ ok: true }>>();
    onCreate.mockResolvedValue({ ok: true });
    renderForm({ initialSendAt: "2026-10-10 12:01:00", onCreate });
    typeText("  あ  ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    expect(onCreate.mock.calls[0]?.[0]).toEqual({
      text: "あ",
      sendAt: "2026-10-10T03:01:00Z",
    });
    expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("");
  });

  it("深夜の日本時間を +09:00 として検証する", async () => {
    const onCreate = vi.fn<(body: { text: string; sendAt: string }) => Promise<{ ok: true }>>();
    onCreate.mockResolvedValue({ ok: true });
    renderForm({ initialSendAt: "2026-11-01 00:30:00", onCreate });
    typeText("夜");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    const body = onCreate.mock.calls[0]?.[0];
    expect(body).toEqual({ text: "夜", sendAt: "2026-10-31T15:30:00Z" });
    expect(body !== undefined && "sendMonth" in body).toBe(false);
  });

  it("早すぎる日時は送らない", async () => {
    const onCreate = vi.fn();
    renderForm({ initialSendAt: "2026-10-10 12:00:00", onCreate });
    typeText("あ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("入力が不正です")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("1年を超える日時は送らない", async () => {
    const onCreate = vi.fn();
    renderForm({ initialSendAt: "2027-10-10 12:01:00", onCreate });
    typeText("あ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("入力が不正です")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("日時が空なら送らない", async () => {
    const onCreate = vi.fn();
    renderForm({ onCreate });
    typeText("あ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("入力が不正です")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("日時の形が違うなら送らない", async () => {
    const onCreate = vi.fn();
    renderForm({ initialSendAt: "2026/10/10 12:01", onCreate });
    typeText("あ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("入力が不正です")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["空", ""],
    ["空白", "   "],
    ["5001", "あ".repeat(5001)],
  ] as const)("文面が%sなら送らない", async (label, text) => {
    expect(label.length).toBeGreaterThan(0);
    const onCreate = vi.fn();
    renderForm({ initialSendAt: "2026-10-10 12:01:00", onCreate });
    typeText(text);
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("入力が不正です")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("上限の文言を残し、文面も残す", async () => {
    const onCreate = vi
      .fn<(body: { text: string; sendAt: string }) => Promise<Failure>>()
      .mockResolvedValue({ ok: false, message: "この月の上限に達しています" });
    renderForm({ initialSendAt: "2026-10-10 12:01:00", onCreate });
    typeText("  あ  ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    expect(await screen.findByText("この月の上限に達しています")).toBeTruthy();
    expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("  あ  ");
  });

  it("送信中は予約するを押せない", async () => {
    let resolveCreate: (value: { ok: true }) => void = () => undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    renderForm({ initialSendAt: "2026-10-10 12:01:00", onCreate });
    typeText("あ");
    fireEvent.click(screen.getByRole("button", { name: "予約する" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "予約する" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    resolveCreate({ ok: true });
    await waitFor(() => {
      expect((screen.getByLabelText("文面") as HTMLTextAreaElement).value).toBe("");
    });
  });
});
