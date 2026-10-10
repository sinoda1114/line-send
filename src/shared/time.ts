export function japanYearMonth(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (year === undefined || month === undefined) {
    throw new Error("month");
  }
  return `${year}-${month}`;
}

export function monthlyLimit(value: string): number {
  if (value === "") {
    return 30;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 30;
  }
  return parsed;
}

const SEND_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function floorUtcMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

export function formatUtcMinute(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addUtcYears(ms: number, years: number): number {
  const date = new Date(ms);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

function isRealUtcDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseSendAt(
  value: string,
  nowMs: number,
): { sendAt: string; sendMonth: string } | null {
  const matched = SEND_AT_PATTERN.exec(value);
  if (matched === null) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!isRealUtcDay(year, month, day)) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const truncated = floorUtcMinute(parsed);
  const earliest = floorUtcMinute(nowMs) + 60_000;
  const latest = addUtcYears(nowMs, 1);
  if (truncated < earliest || truncated > latest) {
    return null;
  }
  return {
    sendAt: formatUtcMinute(truncated),
    sendMonth: japanYearMonth(truncated),
  };
}
