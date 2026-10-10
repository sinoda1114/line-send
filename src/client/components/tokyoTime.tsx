function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

function tokyoParts(ms: number): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
}

export function tokyoWallClock(ms: number): string {
  const parts = tokyoParts(ms);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  const second = part(parts, "second");
  if (
    year === "" ||
    month === "" ||
    day === "" ||
    hour === "" ||
    minute === "" ||
    second === ""
  ) {
    return "";
  }
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function formatTokyoMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "";
  }
  const stamp = tokyoWallClock(ms);
  if (stamp.length < 16) {
    return "";
  }
  return stamp.slice(0, 16);
}
