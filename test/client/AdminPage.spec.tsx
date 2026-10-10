import "./browser";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "../../src/client/pages/AdminPage";

const LINE_ID = "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function renderPage(
  props: Partial<{
    users: {
      id: string;
      displayName: string;
      status: "pending" | "active" | "rejected";
      monthCount: number;
    }[];
    activeCount: number;
    monthlyLimit: number;
    globalLimit: number;
    viewerId: string;
    notice: string | null;
    onApprove: (id: string) => void;
    onReject: (id: string) => void;
  }> = {},
) {
  const onApprove = props.onApprove ?? vi.fn();
  const onReject = props.onReject ?? vi.fn();
  render(
    <MantineProvider>
      <AdminPage
        users={props.users ?? []}
        activeCount={props.activeCount ?? 1}
        monthlyLimit={props.monthlyLimit ?? 30}
        globalLimit={props.globalLimit ?? 180}
        viewerId={props.viewerId ?? "viewer"}
        notice={props.notice ?? null}
        onApprove={onApprove}
        onReject={onReject}
      />
    </MantineProvider>,
  );
  return { onApprove, onReject };
}

afterEach(() => {
  cleanup();
});

describe("AdminPage", () => {
  it("申請中は今月の件数と承認を出す", () => {
    const { onApprove } = renderPage({
      users: [{ id: "pending-1", displayName: "太郎", status: "pending", monthCount: 2 }],
    });
    expect(screen.getByText("申請中")).toBeTruthy();
    expect(screen.getByText("今月 2 件")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "太郎を承認" }));
    expect(onApprove).toHaveBeenCalledWith("pending-1");
  });

  it("却下済みも承認できる", () => {
    const { onApprove } = renderPage({
      users: [{ id: "rejected-1", displayName: "次郎", status: "rejected", monthCount: 0 }],
    });
    expect(screen.getByText("却下済み")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "次郎を承認" }));
    expect(onApprove).toHaveBeenCalledWith("rejected-1");
  });

  it("承認済みの他人は却下できる", () => {
    const { onReject } = renderPage({
      users: [{ id: "active-1", displayName: "花子", status: "active", monthCount: 1 }],
      viewerId: "viewer",
    });
    expect(screen.getByText("承認済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "花子を承認" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "花子を却下" }));
    expect(onReject).toHaveBeenCalledWith("active-1");
  });

  it("自分の行には却下を出さない", () => {
    renderPage({
      users: [{ id: "self", displayName: "管理者", status: "active", monthCount: 0 }],
      viewerId: "self",
    });
    expect(screen.queryByRole("button", { name: "管理者を却下" })).toBeNull();
  });

  it("180 を超える承認ボタンは押せない", () => {
    renderPage({
      users: [{ id: "pending-1", displayName: "太郎", status: "pending", monthCount: 0 }],
      activeCount: 6,
      monthlyLimit: 30,
      globalLimit: 180,
    });
    const button = screen.getByRole("button", { name: "太郎を承認" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("承認後の人数 × 月間上限が 180 を超える承認はできません"),
    ).toBeTruthy();
  });

  it("180 ちょうどなら承認できる", () => {
    renderPage({
      users: [{ id: "pending-1", displayName: "太郎", status: "pending", monthCount: 0 }],
      activeCount: 5,
      monthlyLimit: 30,
      globalLimit: 180,
    });
    const button = screen.getByRole("button", { name: "太郎を承認" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("上限の案内を出す", () => {
    renderPage({ notice: "全体の上限を超えます" });
    expect(screen.getByText("全体の上限を超えます")).toBeTruthy();
  });

  it("LINE の id と予約文面は出さない", () => {
    renderPage({
      users: [{ id: LINE_ID, displayName: "太郎", status: "pending", monthCount: 0 }],
    });
    expect(screen.queryByText(LINE_ID)).toBeNull();
    expect(screen.queryByText("牛乳を買う")).toBeNull();
  });
});
