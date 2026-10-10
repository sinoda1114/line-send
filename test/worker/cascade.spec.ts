import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

async function insertUser(
  id: string,
  lineUserId: string,
  status: "pending" | "active" | "rejected",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, line_user_id, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, lineUserId, "テスト", status, "2026-10-10T00:00:00.000Z")
    .run();
}

async function insertReminder(
  id: string,
  userId: string,
  status: "scheduled" | "sending" | "sent" | "failed",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      userId,
      "文面",
      "2026-10-10T00:00:00Z",
      "2026-10",
      status,
      "2026-10-10T00:00:00.000Z",
      "2026-10-10T00:00:00.000Z",
    )
    .run();
}

async function countReminders(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ n: number }>();
  if (!row) {
    throw new Error("count failed");
  }
  return row.n;
}

it("creates the approved tables and indexes", async () => {
  const listed = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?, ?) ORDER BY name",
  )
    .bind(
      "idx_reminders_due",
      "idx_reminders_month",
      "idx_reminders_sending",
      "idx_reminders_user",
      "reminders",
      "users",
    )
    .all<{ name: string }>();

  expect(listed.results.map((row) => row.name)).toEqual([
    "idx_reminders_due",
    "idx_reminders_month",
    "idx_reminders_sending",
    "idx_reminders_user",
    "reminders",
    "users",
  ]);
});

it("deletes every reminder when the user row is deleted", async () => {
  await insertUser(userA, "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "active");
  await insertUser(userB, "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "pending");
  await insertReminder("33333333-3333-4333-8333-333333333301", userA, "scheduled");
  await insertReminder("33333333-3333-4333-8333-333333333302", userA, "sending");
  await insertReminder("33333333-3333-4333-8333-333333333303", userA, "sent");
  await insertReminder("33333333-3333-4333-8333-333333333304", userA, "failed");
  await insertReminder("33333333-3333-4333-8333-333333333305", userB, "scheduled");

  const deleted = await env.DB.prepare("DELETE FROM users WHERE id = ?")
    .bind(userA)
    .run();

  // D1 counts the user row and the cascaded reminder rows.
  expect(deleted.meta.changes).toBe(5);
  expect(await countReminders(userA)).toBe(0);
  expect(await countReminders(userB)).toBe(1);
  const remaining = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(userB)
    .first<{ id: string }>();
  expect(remaining?.id).toBe(userB);
});

it("rejects a reminder whose user does not exist", async () => {
  await expect(
    insertReminder(
      "33333333-3333-4333-8333-333333333399",
      "99999999-9999-4999-8999-999999999999",
      "scheduled",
    ),
  ).rejects.toThrow(/FOREIGN KEY constraint failed/);
});
