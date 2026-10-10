import {
  pushMessage,
  tokenContainsLineBreak,
  type PushOutcome,
} from "../line/push";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

type Candidate = {
  id: string;
  lineUserId: string;
  status: "scheduled" | "sending";
  attempts: number;
  updatedAt: string;
  sortAt: string;
};

type ReminderRow = {
  id: string;
  text: string;
  attempts: number;
};

type DueRow = {
  id: string;
  attempts: number;
  updated_at: string;
  send_at: string;
  line_user_id: string;
};

type StaleRow = {
  id: string;
  attempts: number;
  updated_at: string;
  line_user_id: string;
};

export async function dispatch(
  db: D1Database,
  token: string,
  scheduledTime: number,
): Promise<void> {
  if (token === "" || tokenContainsLineBreak(token)) {
    return;
  }

  const now = utcSeconds(scheduledTime);
  const due = await nextDue(db, now);
  const stale = await nextStaleSending(
    db,
    utcSeconds(scheduledTime - FIVE_MINUTES_MS),
  );
  const candidate = earlierCandidate(due, stale);
  if (candidate === null) {
    return;
  }

  const claimed = await claim(db, candidate, now);
  if (claimed.meta.changes !== 1) {
    return;
  }

  const row = await loadClaimed(db, claimed.results, candidate.id);
  if (row === null) {
    return;
  }

  const outcome = await pushMessage(
    token,
    candidate.lineUserId,
    row.text,
    candidate.id,
  );
  await applyOutcome(db, candidate, row.attempts, now, outcome);
}

function utcSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function nextDue(db: D1Database, now: string): Promise<Candidate | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.attempts, r.updated_at, r.send_at, u.line_user_id
       FROM reminders AS r INDEXED BY idx_reminders_due
       INNER JOIN users AS u ON u.id = r.user_id
       WHERE r.status = 'scheduled' AND r.send_at <= ?1 AND u.status = 'active'
       ORDER BY r.send_at, r.id
       LIMIT 1`,
    )
    .bind(now)
    .first<DueRow>();
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    status: "scheduled",
    attempts: row.attempts,
    updatedAt: row.updated_at,
    sortAt: row.send_at,
  };
}

async function nextStaleSending(
  db: D1Database,
  staleBefore: string,
): Promise<Candidate | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.attempts, r.updated_at, u.line_user_id
       FROM reminders AS r INDEXED BY idx_reminders_sending
       INNER JOIN users AS u ON u.id = r.user_id
       WHERE r.status = 'sending' AND r.updated_at <= ?1 AND u.status = 'active'
       ORDER BY r.updated_at, r.id
       LIMIT 1`,
    )
    .bind(staleBefore)
    .first<StaleRow>();
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    status: "sending",
    attempts: row.attempts,
    updatedAt: row.updated_at,
    sortAt: row.updated_at,
  };
}

function earlierCandidate(
  due: Candidate | null,
  stale: Candidate | null,
): Candidate | null {
  if (due === null) {
    return stale;
  }
  if (stale === null) {
    return due;
  }
  if (stale.sortAt < due.sortAt) {
    return stale;
  }
  return due;
}

async function claim(
  db: D1Database,
  candidate: Candidate,
  now: string,
): Promise<D1Result<ReminderRow>> {
  return await db
    .prepare(
      `UPDATE reminders
       SET status = 'sending', attempts = attempts + 1, updated_at = ?1
       WHERE id = ?2 AND status = ?3 AND updated_at = ?4
         AND user_id IN (SELECT id FROM users WHERE status = 'active')
       RETURNING *`,
    )
    .bind(now, candidate.id, candidate.status, candidate.updatedAt)
    .run<ReminderRow>();
}

async function loadClaimed(
  db: D1Database,
  results: readonly ReminderRow[],
  id: string,
): Promise<ReminderRow | null> {
  const returned = results[0];
  if (returned !== undefined) {
    return returned;
  }
  return await db
    .prepare("SELECT id, text, attempts FROM reminders WHERE id = ?1")
    .bind(id)
    .first<ReminderRow>();
}

async function applyOutcome(
  db: D1Database,
  candidate: Candidate,
  attemptsAfter: number,
  now: string,
  outcome: PushOutcome,
): Promise<void> {
  switch (outcome.type) {
    case "sent":
      await db
        .prepare(
          `UPDATE reminders
           SET status = 'sent', sent_at = ?1
           WHERE id = ?2 AND status = 'sending' AND updated_at = ?3`,
        )
        .bind(now, candidate.id, now)
        .run();
      return;
    case "stop":
      await db
        .prepare(
          `UPDATE reminders
           SET status = 'scheduled', attempts = ?1, updated_at = ?2
           WHERE id = ?3 AND status = 'sending' AND updated_at = ?4`,
        )
        .bind(candidate.attempts, candidate.updatedAt, candidate.id, now)
        .run();
      return;
    case "retry":
      if (attemptsAfter < 3) {
        await db
          .prepare(
            `UPDATE reminders
             SET status = 'scheduled'
             WHERE id = ?1 AND status = 'sending' AND updated_at = ?2`,
          )
          .bind(candidate.id, now)
          .run();
        return;
      }
      await markFailed(db, candidate.id, now, outcome.reason);
      return;
    case "fail":
      await markFailed(db, candidate.id, now, outcome.reason);
      return;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

async function markFailed(
  db: D1Database,
  id: string,
  claimUpdatedAt: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reminders
       SET status = 'failed', last_error = ?1
       WHERE id = ?2 AND status = 'sending' AND updated_at = ?3`,
    )
    .bind(reason, id, claimUpdatedAt)
    .run();
}
