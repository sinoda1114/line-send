import { describe, expect, it } from "vitest";
import { parseReminderText } from "../../src/shared/schema";
import { japanYearMonth, parseSendAt } from "../../src/shared/time";

const nowMs = Date.parse("2026-10-10T03:00:30.000Z");

describe("parseSendAt", () => {
  it("切り捨てと日本時間の月を返す", () => {
    expect(parseSendAt("2026-10-10T03:01:00Z", nowMs)).toEqual({
      sendAt: "2026-10-10T03:01:00Z",
      sendMonth: "2026-10",
    });
    expect(parseSendAt("2026-10-10T03:01:59.999Z", nowMs)).toEqual({
      sendAt: "2026-10-10T03:01:00Z",
      sendMonth: "2026-10",
    });
    expect(parseSendAt("2026-10-10T12:01:45+09:00", nowMs)).toEqual({
      sendAt: "2026-10-10T03:01:00Z",
      sendMonth: "2026-10",
    });
    const november = parseSendAt("2026-11-01T00:30:00+09:00", nowMs);
    expect(november).toEqual({
      sendAt: "2026-10-31T15:30:00Z",
      sendMonth: "2026-11",
    });
    expect(november?.sendMonth).toBe(japanYearMonth(Date.parse("2026-10-31T15:30:00Z")));
  });

  it("現在の分、1年の境界、形の違い、存在しない日は拒否する", () => {
    expect(parseSendAt("2026-10-10T03:00:59Z", nowMs)).toBeNull();
    expect(parseSendAt("2027-10-10T03:00:00Z", nowMs)).toEqual({
      sendAt: "2027-10-10T03:00:00Z",
      sendMonth: "2027-10",
    });
    expect(parseSendAt("2027-10-10T03:01:00Z", nowMs)).toBeNull();
    expect(parseSendAt("2026-10-10T03:01:00", nowMs)).toBeNull();
    expect(parseSendAt("2026-10-10", nowMs)).toBeNull();
    expect(parseSendAt("2026-10-10T03:01:00z", nowMs)).toBeNull();
    expect(parseSendAt("2026-02-31T00:00:00Z", nowMs)).toBeNull();
    expect(parseSendAt("2026-11-31T00:00:00Z", nowMs)).toBeNull();
    expect(parseSendAt("2027-02-29T03:01:00Z", nowMs)).toBeNull();
  });

  it("うるう日そのものは受ける", () => {
    const leapDay = Date.parse("2024-02-28T12:00:30.000Z");
    expect(parseSendAt("2024-02-29T12:01:00Z", leapDay)).toEqual({
      sendAt: "2024-02-29T12:01:00Z",
      sendMonth: "2024-02",
    });
  });

  it("2月29日の1年後は JavaScript の暦で3月1日まで受ける", () => {
    const leapNow = Date.parse("2024-02-29T12:00:30.000Z");
    expect(parseSendAt("2025-03-01T12:00:00Z", leapNow)).toEqual({
      sendAt: "2025-03-01T12:00:00Z",
      sendMonth: "2025-03",
    });
    expect(parseSendAt("2025-03-01T12:01:00Z", leapNow)).toBeNull();
  });
});

describe("parseReminderText", () => {
  it("前後の空白を除き、UTF-16 の長さで 1 から 5000 まで受ける", () => {
    expect(parseReminderText("  あ  ")).toBe("あ");
    expect(parseReminderText("😀")).toBe("😀");
    expect("😀".length).toBe(2);
    expect(parseReminderText("😀".repeat(2500))).toBe("😀".repeat(2500));
    expect("😀".repeat(2500).length).toBe(5000);
    expect(parseReminderText("😀".repeat(2501))).toBeNull();
    expect(parseReminderText("   ")).toBeNull();
  });
});
