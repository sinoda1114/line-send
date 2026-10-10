export type ReminderStatus = "scheduled" | "sending" | "sent" | "failed";

export type ReminderPublic = {
  id: string;
  text: string;
  sendAt: string;
  sendMonth: string;
  status: ReminderStatus;
  sentAt: string | null;
};

export type ReminderView = "upcoming" | "history";

type ReminderSql = {
  id: string;
  text: string;
  send_at: string;
  send_month: string;
  status: ReminderStatus;
  sent_at: string | null;
};

export type ScheduledInsert = {
  id: string;
  userId: string;
  text: string;
  sendAt: string;
  sendMonth: string;
  createdAt: string;
};

export async function insertScheduledReminder(
  db: D1Database,
  row: ScheduledInsert,
  limit: number,
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'scheduled', ?6, ?6
       WHERE (SELECT COUNT(*) FROM reminders
              WHERE user_id = ?2 AND send_month = ?5 AND status != 'failed') < ?7`,
    )
    .bind(row.id, row.userId, row.text, row.sendAt, row.sendMonth, row.createdAt, limit)
    .run();
  return inserted.meta.changes;
}

export async function listOwnReminders(
  db: D1Database,
  userId: string,
  view: ReminderView,
): Promise<ReminderPublic[]> {
  switch (view) {
    case "upcoming": {
      const listed = await db
        .prepare(
          `SELECT id, text, send_at, send_month, status, sent_at
           FROM reminders
           WHERE user_id = ?1 AND status IN ('scheduled', 'sending')
           ORDER BY send_at ASC, id ASC`,
        )
        .bind(userId)
        .all<ReminderSql>();
      return listed.results.map(mapReminder);
    }
    case "history": {
      const listed = await db
        .prepare(
          `SELECT id, text, send_at, send_month, status, sent_at
           FROM reminders
           WHERE user_id = ?1 AND status IN ('sent', 'failed')
           ORDER BY send_at DESC, id DESC
           LIMIT 50`,
        )
        .bind(userId)
        .all<ReminderSql>();
      return listed.results.map(mapReminder);
    }
    default: {
      const unreachable: never = view;
      throw new Error(unreachable);
    }
  }
}

export async function deleteScheduledReminder(
  db: D1Database,
  id: string,
  userId: string,
): Promise<number> {
  const deleted = await db
    .prepare(
      `DELETE FROM reminders
       WHERE id = ?1 AND user_id = ?2 AND status = 'scheduled'`,
    )
    .bind(id, userId)
    .run();
  return deleted.meta.changes;
}

function mapReminder(row: ReminderSql): ReminderPublic {
  return {
    id: row.id,
    text: row.text,
    sendAt: row.send_at,
    sendMonth: row.send_month,
    status: row.status,
    sentAt: row.sent_at,
  };
}
