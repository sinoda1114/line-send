import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/client/App";

describe("App", () => {
  it("空の画面を出す", () => {
    render(<App />);
    expect(screen.getByRole("main")).toBeTruthy();
  });
});
