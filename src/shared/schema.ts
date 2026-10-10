import { z } from "zod";
import { parseSendAt } from "./time";

export const reminderBodySchema = z.object({
  text: z.string(),
  sendAt: z.string(),
});

export type ReminderDraft = {
  text: string;
  sendAt: string;
  sendMonth: string;
};

export function parseReminderText(value: string): string | null {
  const text = value.trim();
  if (text.length < 1 || text.length > 5000) {
    return null;
  }
  return text;
}

export function parseReminderBody(body: unknown, nowMs: number): ReminderDraft | null {
  const parsed = reminderBodySchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const text = parseReminderText(parsed.data.text);
  if (text === null) {
    return null;
  }
  const when = parseSendAt(parsed.data.sendAt, nowMs);
  if (when === null) {
    return null;
  }
  return { text, sendAt: when.sendAt, sendMonth: when.sendMonth };
}
