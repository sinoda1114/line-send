import type { Context } from "hono";
import { parseReminderBody } from "../../shared/schema";
import { monthlyLimit } from "../../shared/time";
import {
  deleteScheduledReminder,
  insertScheduledReminder,
  listOwnReminders,
  type ReminderPublic,
  type ReminderView,
} from "../db/reminders";
import { fail, type AppEnv } from "../http";

const INVALID_INPUT = "入力が不正です";

export async function listReminders(c: Context<AppEnv>): Promise<Response> {
  const view = readView(c);
  if (view === null) {
    return fail(c, 400, "INVALID_INPUT", INVALID_INPUT);
  }
  const reminders = await listOwnReminders(c.env.DB, c.get("user").id, view);
  return c.json({ success: true, data: { reminders }, error: null });
}

export async function createReminder(c: Context<AppEnv>): Promise<Response> {
  const nowMs = c.get("nowMs");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "INVALID_INPUT", INVALID_INPUT);
  }
  const draft = parseReminderBody(body, nowMs);
  if (draft === null) {
    return fail(c, 400, "INVALID_INPUT", INVALID_INPUT);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  const changes = await insertScheduledReminder(
    c.env.DB,
    {
      id,
      userId: c.get("user").id,
      text: draft.text,
      sendAt: draft.sendAt,
      sendMonth: draft.sendMonth,
      createdAt,
    },
    monthlyLimit(c.env.MONTHLY_LIMIT),
  );
  if (changes === 0) {
    return fail(c, 429, "QUOTA_EXCEEDED", "この月の上限に達しています");
  }
  if (changes !== 1) {
    throw new Error("予約を作成できません");
  }
  const reminder: ReminderPublic = {
    id,
    text: draft.text,
    sendAt: draft.sendAt,
    sendMonth: draft.sendMonth,
    status: "scheduled",
    sentAt: null,
  };
  return c.json({ success: true, data: { reminder }, error: null }, 201);
}

export async function deleteReminder(c: Context<AppEnv>): Promise<Response> {
  const changes = await deleteScheduledReminder(
    c.env.DB,
    c.req.param("id") ?? "",
    c.get("user").id,
  );
  if (changes === 1) {
    return c.json({ success: true, data: { ok: true }, error: null });
  }
  if (changes === 0) {
    return fail(c, 404, "NOT_FOUND", "予約が見つかりません");
  }
  throw new Error("予約を取り消せません");
}

function readView(c: Context<AppEnv>): ReminderView | null {
  const views = c.req.queries("view");
  if (views === undefined || views.length !== 1) {
    return null;
  }
  const view = views[0];
  if (view === "upcoming" || view === "history") {
    return view;
  }
  return null;
}
