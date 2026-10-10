import "./browser";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../../src/client/components/AccountMenu";

function renderMenu(canWithdraw: boolean, onWithdraw: () => void) {
  return render(
    <MantineProvider>
      <AccountMenu
        displayName="太郎"
        canWithdraw={canWithdraw}
        onLogout={vi.fn()}
        onWithdraw={onWithdraw}
      />
    </MantineProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AccountMenu", () => {
  it("退会できる人には表示名と退会を出し、確認はまだ出さない", () => {
    renderMenu(true, vi.fn());
    expect(screen.getByText("太郎")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退会" })).toBeTruthy();
    expect(screen.queryByText("退会すると予約も消えます")).toBeNull();
  });

  it("キャンセルは確認を閉じて退会を呼ばない", () => {
    const onWithdraw = vi.fn();
    renderMenu(true, onWithdraw);
    fireEvent.click(screen.getByRole("button", { name: "退会" }));
    expect(screen.getByText("退会すると予約も消えます")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByText("退会すると予約も消えます")).toBeNull();
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("退会するだけが退会を1回呼ぶ", () => {
    const onWithdraw = vi.fn();
    renderMenu(true, onWithdraw);
    fireEvent.click(screen.getByRole("button", { name: "退会" }));
    fireEvent.click(screen.getByRole("button", { name: "退会する" }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("退会できない人には退会を出さない", () => {
    renderMenu(false, vi.fn());
    expect(screen.queryByRole("button", { name: "退会" })).toBeNull();
    expect(screen.queryByText("退会すると予約も消えます")).toBeNull();
  });
});
