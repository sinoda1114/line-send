import "./browser";
import { MantineProvider } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReminderList } from "../../src/client/components/ReminderList";
import type { Reminder } from "../../src/client/api";

function item(status: Reminder["status"], id: string): Reminder {
  return {
    id,
    text: `${status}の文面`,
    sendAt: "2026-10-31T15:30:00Z",
    sendMonth: "2026-11",
    status,
    sentAt: null,
  };
}

function renderList(upcoming: Reminder[], history: Reminder[]) {
  return render(
    <MantineProvider>
      <DatesProvider settings={{ locale: "ja" }}>
        <ReminderList upcoming={upcoming} history={history} pendingIds={new Set()} onDelete={vi.fn()} />
      </DatesProvider>
    </MantineProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("ReminderList", () => {
  it("UTC の送信時刻を日本時間で出す", () => {
    renderList([item("scheduled", "rem-1")], []);
    expect(screen.getByText("2026-11-01 00:30")).toBeTruthy();
    expect(screen.getByText("scheduledの文面")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取り消す" })).toBeTruthy();
  });

  it("送信中は取り消せない", () => {
    renderList([item("sending", "rem-2")], []);
    expect(screen.getByText("送信中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
  });

  it("送信待ちに送信済みが混ざっても取り消すのは予定だけである", () => {
    renderList([item("scheduled", "rem-1"), item("sent", "rem-3")], []);
    expect(screen.getAllByRole("button", { name: "取り消す" })).toHaveLength(1);
    expect(screen.getByText("送信済み")).toBeTruthy();
  });

  it("履歴は送信済みと失敗で、取り消しは無い", () => {
    renderList([], [item("sent", "rem-3"), item("failed", "rem-4")]);
    screen.getByRole("tab", { name: "履歴" }).click();
    expect(screen.getByText("送信済み")).toBeTruthy();
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
  });

  it("0件の文言を出す", () => {
    renderList([], []);
    expect(screen.getByText("送信待ちはありません")).toBeTruthy();
    screen.getByRole("tab", { name: "履歴" }).click();
    expect(screen.getByText("履歴はありません")).toBeTruthy();
  });

  it("時刻が読めない行は空の時刻にする", () => {
    renderList([{ ...item("scheduled", "rem-1"), sendAt: "not-a-date" }], []);
    expect(screen.queryByText("2026-11-01 00:30")).toBeNull();
  });

  it("取り消し中の行だけ押せない", () => {
    render(
      <MantineProvider>
        <DatesProvider settings={{ locale: "ja" }}>
          <ReminderList
            upcoming={[item("scheduled", "rem-1"), item("scheduled", "rem-2")]}
            history={[]}
            pendingIds={new Set(["rem-1"])}
            onDelete={vi.fn()}
          />
        </DatesProvider>
      </MantineProvider>,
    );
    const buttons = screen.getAllByRole("button", { name: "取り消す" }) as HTMLButtonElement[];
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
  });
});
