CREATE TABLE users (
  id            TEXT PRIMARY KEY,               -- UUID
  line_user_id  TEXT NOT NULL UNIQUE,           -- ID トークンの sub。U + 16進32文字
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected')),
  created_at    TEXT NOT NULL,                  -- ISO 8601 (UTC)
  decided_at    TEXT                            -- 承認・却下した日時。pending では NULL
);

CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,                 -- UUID（RFC 4122）。LINE の X-Line-Retry-Key にも使う
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,                    -- UTF-16 コードユニットで 1〜5000。SQL の length() では検査しない
  send_at     TEXT NOT NULL,                    -- 'YYYY-MM-DDTHH:mm:00Z'
  send_month  TEXT NOT NULL,                    -- 'YYYY-MM'（日本時間）。月間上限の集計用
  status      TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_reminders_due ON reminders (status, send_at);
CREATE INDEX idx_reminders_user ON reminders (user_id, send_at);
CREATE INDEX idx_reminders_month ON reminders (user_id, send_month);
CREATE INDEX idx_reminders_sending ON reminders (status, updated_at);
