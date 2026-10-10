# 02. 仕様書

- 対象: line-send
- 作成日: 2026-10-10
- 改訂: 2026-10-10（無料枠の送信、却下、Preview、文字数、再送の分類を確定）
- 関連文書: [01_REQUIREMENTS.md](01_REQUIREMENTS.md) / [03_STRUCTURE.md](03_STRUCTURE.md)

## 1. アーキテクチャ

```
                         ┌──────────────── Cloudflare Workers（1 つの Worker）────────────────┐
LINE アプリ（LIFF）──┐   │  静的配信: React + Mantine の画面（PWA）                            │
ブラウザ / ホーム画面 ┼──▶│  fetch:    /api/*  Hono の JSON API ──────────┐                     │
                     │   │  scheduled: 毎分の Cron Trigger → 送信処理 ───┤                     │
                     │   └───────────────────────────────────────────────┼─────────────────────┘
                     │                                                   ▼
                     │                                              D1 (SQLite)
                     │                                                   │
                     └── ID トークン検証 ◀── LINE Login              push ▼
                                                              LINE Messaging API ──▶ 本人の LINE
```

| 要素 | 技術 | 役割 |
| --- | --- | --- |
| 実行基盤 | Cloudflare Workers | 画面の静的配信、JSON API、Cron Trigger を 1 つの Worker で担う |
| API | Hono | ルーティング、Cookie、入力検証 |
| 入力検証 | Zod | 画面と API で同じスキーマを共有 |
| 画面 | React + Mantine（`@mantine/core`、`@mantine/dates`） | 予約フォーム・一覧・管理画面 |
| ビルド | Vite + `@cloudflare/vite-plugin` | 画面と Worker を 1 回でビルド・開発 |
| LINE 連携（画面） | LIFF SDK（`@line/liff`） | LINE 内での自動ログイン、外部ブラウザでの LINE ログイン、友だち状態の取得 |
| LINE 連携（サーバー） | LINE Login の ID トークン検証、Messaging API の push | 本人確認と送信 |
| データ | D1 | 利用者・予約 |

画面と API は分ける（API ファースト）。後から HTTP API（API キー方式）やネイティブアプリを足しても、API 側はそのまま使える。

本番だけが Cron を持つ。Preview は Cron を持たない。

## 2. 設定値

| 名前 | 種別 | 内容 |
| --- | --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | secret | Messaging API チャネルのアクセストークン（長期）。本番だけに置く |
| `LINE_LOGIN_CHANNEL_ID` | var | LINE ログインチャネルの ID。ID トークン検証に使う |
| `LIFF_ID` | var | LIFF アプリの ID。画面のビルド時にも `VITE_LIFF_ID` として渡す。本番と開発で別の LIFF を使う |
| `SESSION_SECRET` | secret | セッション Cookie 署名用。32 バイト以上の乱数 |
| `ADMIN_LINE_USER_ID` | secret | 管理者（篠田）の LINE userId |
| `APP_ORIGIN` | var | その環境の公開 URL。Origin 検査に使う。本番と Preview で値を変える |
| `MONTHLY_LIMIT` | var | 1 人あたりの月間送信上限。既定は 30。整数として読む |

secret は `wrangler secret put` で登録する。ローカルは `.dev.vars`（Git 管理外）を使う。`LIFF_ID` と `LINE_LOGIN_CHANNEL_ID` は公開されても問題ない値である。

バインディングの型は `wrangler types` が生成したものを使う。手書きの `Env` は置かない。

## 3. 状態

### 3.1 利用者

| 状態 | 意味 | 遷移 |
| --- | --- | --- |
| `pending` | 申請済み・未承認 | 初回ログインで作成。退会で行を削除できる |
| `active` | 承認済み。予約できる | 管理者が承認。退会で行を削除できる |
| `rejected` | 却下 | 管理者が却下。退会できない。再ログインしても `rejected` のまま。管理者はあとから `active` にできる |

- 管理者は初回ログイン時に `active` で作成する。管理者は退会できない。
- 退会は行の削除とする（予約も削除）。対象は `pending` と `active` だけである。
- 却下したとき、その利用者の `scheduled` は削除する。`sending` は送信処理に任せ、`sent` と `failed` は残す。
- 同じ `line_user_id` の初回作成が同時に走ったときは、UNIQUE 制約で負けた側が既存行を読み直す。

### 3.2 予約

```
scheduled ──(送信時刻・送信処理が確保)──▶ sending ──成功──▶ sent
    ▲                                        │
    └────(一時的な失敗・試行 3 回未満)───────┤
                                             └──恒久的な失敗 or 3 回失敗──▶ failed
scheduled ──(利用者が取り消し、または管理者が却下)──▶ 行を削除
```

`sending` は送信待ちの一覧に含める。利用者は取り消せない。

## 4. データ構造（D1・承認済み）

初版のマイグレーションは `migrations/0001_init.sql` とする。列の追加はしない。

```sql
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
```

- 月間上限は、`send_month` が同じ月の予約（`scheduled`・`sending`・`sent`）の件数で数える。取り消すと枠が空く。`failed` は数えない。
- D1 は外部キーを既定で強制する。`PRAGMA foreign_keys` は変更できない。マイグレーション中に一時的に外すときは `PRAGMA defer_foreign_keys = on` を使う。退会は `DELETE FROM users` とし、`ON DELETE CASCADE` で予約を消す。
- 文面は退会か取り消しまで残す。期限では消さない。
- 月間上限の 429 で毎分叩き続けるのを止める停止表は、初版には置かない。承認時の人数チェックで足りる。

## 5. 本人確認とセッション

### 5.1 ログインの流れ

1. 画面が `liff.init({ liffId })` を呼ぶ。
2. LINE アプリ内なら自動でログイン済みになる。外部ブラウザで未ログインなら `liff.login()` で LINE ログインへ移る（FR-08）。
3. 画面が `liff.getIDToken()` で ID トークンを取り、`POST /api/session` に送る。
4. サーバーは `POST https://api.line.me/oauth2/v2.1/verify` に `id_token` と `client_id`（`LINE_LOGIN_CHANNEL_ID`）を送って検証する（NFR-02）。`aud` がそのチャネル ID と一致し、`exp` が過ぎていないことを合格条件にする。`sub` は `U` と 16 進 32 文字だけを受ける。
5. 検証できたら `sub` で利用者を作成または取得し、セッション Cookie を発行する。表示名は ID トークンの `name` を使い、無いときは「LINEユーザー」とする。再ログインでは表示名を更新しない。

友だち状態は画面側で `liff.getFriendship()` を呼んで確認し、未追加なら追加を案内する（FR-09）。LIFF アプリの設定で「友だち追加オプション」を有効にする。サーバーは友だち状態を送信条件にしない。未追加やブロックでも LINE は 200 を返すことがあり、その予約は `sent` になる。

### 5.2 セッションと CSRF

- セッションは HMAC-SHA256 で署名した Cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`）。中身は `users.id`（UUID）と有効期限（7 日）。
- ローカルの `http://localhost` では `Secure` を付けない。それ以外は付ける。
- 各 API は Cookie の `users.id` で行を引く。行が無い、または期限切れなら 401 である。
- 状態を変える API（POST・DELETE）は、`Content-Type: application/json` であることと、`Origin` がその環境の `APP_ORIGIN` と一致することを確認する（NFR-04）。
- 管理者判定は、セッションの利用者の `line_user_id` が `ADMIN_LINE_USER_ID` と一致するかで行う（FR-16）。比較は長さを揃えたダイジェストで行う。

## 6. JSON API

レスポンスは共通の形にする。

```json
{ "success": true, "data": { }, "error": null }
{ "success": false, "data": null, "error": { "code": "QUOTA_EXCEEDED", "message": "..." } }
```

| メソッド・パス | 権限 | 内容 |
| --- | --- | --- |
| `POST /api/session` | 誰でも | `{ idToken }` を検証してセッション発行。`data.user` を返す |
| `DELETE /api/session` | ログイン済み | ログアウト |
| `GET /api/me` | ログイン済み | 利用者の状態、当月の予約数と上限（FR-14） |
| `DELETE /api/me` | `pending` または `active`。管理者は不可 | 退会（FR-15）。`rejected` と管理者は 403 |
| `GET /api/reminders` | `active` | 自分の予約だけ。`?view=upcoming`（`scheduled` と `sending`、時刻順）/ `?view=history`（`sent` と `failed`、新しい順、最大 50 件） |
| `POST /api/reminders` | `active` | `{ text, sendAt }` で予約作成。201 |
| `DELETE /api/reminders/:id` | `active` | 自分の `scheduled` だけ削除する。条件に合わない場合は 404。`sending` も 404 |
| `GET /api/admin/users` | 管理者 | 利用者一覧（状態・当月の予約数） |
| `POST /api/admin/users/:id/approve` | 管理者 | `pending` または `rejected` を `active` にする。既に `active` なら 404。承認後の active 人数 × `MONTHLY_LIMIT` が 180 を超えるなら 403 |
| `POST /api/admin/users/:id/reject` | 管理者 | `pending` または `active` を `rejected` にする。その利用者の `scheduled` を削除する。管理者自身は 403 |

主なエラー:

| 条件 | ステータス | `error.code` |
| --- | --- | --- |
| 入力が不正 | 400 | `INVALID_INPUT` |
| 未ログイン・セッション切れ・ID トークン不正 | 401 | `UNAUTHORIZED` |
| `active` でない、管理者でない、CSRF 検査に失敗、退会できない、承認の全体枠を超える | 403 | `FORBIDDEN` |
| 対象がない、または他人のもの | 404 | `NOT_FOUND` |
| 月間上限に到達 | 429 | `QUOTA_EXCEEDED` |

### 6.1 予約作成の検証

| 項目 | ルール |
| --- | --- |
| `text` | 前後の空白を除いたあと、JavaScript の文字列長（UTF-16 コードユニット）で 1〜5000。絵文字 1 個は 2。SQL の `length()` は使わない |
| `sendAt` | オフセット付きの ISO 8601 だけを受ける。秒以下を切り捨て、`YYYY-MM-DDTHH:mm:00Z` にする。切り捨て後の時刻が、現在の分より 1 分以上先、かつ 1 年以内 |
| `send_month` | サーバーが `send_at` を日本時間に直して `YYYY-MM` にする。クライアントからは受け取らない |
| 月間上限 | その `send_month` の予約数が `MONTHLY_LIMIT` 未満 |

上限の確認と挿入は 1 文の SQL で行い、同時に作成しても上限を超えないようにする。

```sql
INSERT INTO reminders (id, user_id, text, send_at, send_month, status, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, 'scheduled', ?6, ?6
WHERE (SELECT COUNT(*) FROM reminders
       WHERE user_id = ?2 AND send_month = ?5 AND status != 'failed') < ?7;
```

変更行数が 0 なら 429 を返す。

## 7. 送信処理（Cron Trigger）

- 本番の `wrangler` 設定で `crons = ["* * * * *"]`（毎分）とする。Preview には Cron を付けない。
- 時刻は Cron イベントの `scheduledTime` を使う。`Date.now()` は使わない。
- 1 回の処理は 1 件だけ送る（NFR-07）。
- 流れ:
  1. 次のどちらかを 1 件取る。利用者の `status` が `active` のものに限る。
     - `reminders.status = 'scheduled' AND send_at <= scheduledTime`
     - `reminders.status = 'sending' AND updated_at <= scheduledTime の 5 分前`
     時刻が早いものを優先する。
  2. `UPDATE reminders SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ? AND user_id IN (SELECT id FROM users WHERE status = 'active') RETURNING *` で確保する。`status` の条件は取得時の状態である。行が返らなければ、その回は何も送らない。
  3. 本人の `line_user_id` へ `POST https://api.line.me/v2/bot/message/push` で送る。本文は `{ "to": "...", "messages": [{ "type": "text", "text": "..." }] }`。末尾スラッシュは付けない。
  4. 初回から `X-Line-Retry-Key` に予約の `id` を付ける。値は RFC 4122 の UUID である。有効期間は 24 時間で、再送は数分以内に収まる。同じ予約を再送しても LINE 側で重複が除かれる（NFR-05）。
  5. 結果に応じて更新する。

| LINE の応答 | 予約の更新 |
| --- | --- |
| 200、または 409（同じ Retry Key で送信済み） | `sent`、`sent_at` を記録。409 でも push は `sentMessages` を返す |
| 429 でレート制限、かつ `attempts < 3` | `scheduled` に戻す。次の分に再送する |
| 5xx または通信エラー、かつ `attempts < 3` | `scheduled` に戻す。次の分に再送する |
| 上記で `attempts >= 3` | `failed`、`last_error` に理由 |
| 400・403 | `failed`、`last_error` に理由。再送しない |
| 401、または月間上限の 429 | その予約を `scheduled` に戻し、`attempts` は増やす前の値に戻す。その回の残りは送らない。ログにはトークンも文面も出さない |

ブロック中や友だち未追加でも LINE は 200 を返すことがある。その場合も `sent` とし、届いたとは扱わない。

退会で利用者の行を消すと予約も消えるため、送られない（AC-11）。`active` でない利用者の予約は手順 1 で取らない。

## 8. 画面

| 画面 | 対象 | 内容 |
| --- | --- | --- |
| 予約 | `active` | 上部に予約フォーム（文面 + 日時。Mantine の `DateTimePicker`、日本時間）。下に送信待ち（`scheduled` と `sending`。取り消しは `scheduled` だけ）と履歴タブ。当月の残り枠を表示 |
| 申請中 | `pending` | 「承認待ちです」の表示。退会できる |
| 却下 | `rejected` | 利用できない旨の表示。退会は出さない |
| 管理 | 管理者 | 申請中と却下済みの承認、利用者の却下、全利用者の当月予約数。全体枠を超える承認はできない旨を出す |
| 共通 | 全員 | 友だち未追加の案内、ログアウト。退会は `pending` と `active` の非管理者だけ（確認ダイアログあり） |

- 画面は状態で切り替え、ルーティングのライブラリは使わない（管理者だけタブで管理画面を出す）。
- スマホ幅 375px を基準にする（NFR-10）。
- PWA として `manifest.webmanifest` とアイコンを置く。オフラインキャッシュは持たない。Android のホーム画面追加に必要な場合だけ、キャッシュしない Service Worker を置く。
- 日時の入力と一覧は日本時間で見せる。

## 9. 配置先

| 環境 | 配置先 | 反映方法 |
| --- | --- | --- |
| ローカル | `vite dev`（`@cloudflare/vite-plugin`）+ ローカル D1 | 手動。Cron は `/cdn-cgi/handler/scheduled` で手動起動 |
| Preview | Workers の Preview URL。別 D1。Cron なし。本番トークンなし | feature ブランチの push。`APP_ORIGIN` はその Preview の URL |
| Production | Workers 本番。本番 D1。Cron あり | main マージで自動デプロイし、`wrangler d1 migrations apply` を実行する（NFR-09） |

LIFF アプリのエンドポイント URL は本番の `APP_ORIGIN` にする。LIFF は 1 アプリにつき URL が 1 つのため、ローカル確認用に開発用 LIFF アプリを別に作る。本番開始時に LIFF を公開し、公開しないと篠田以外は開けない。

## 10. 検証仕様

| 対象 | 方法 | 対応 |
| --- | --- | --- |
| 入力検証（文面・日時・UTF-16・秒の切り捨て） | 単体テスト | FR-01, §6.1 |
| 月間上限（同時作成を含む） | D1 を使う結合テスト | FR-12, AC-08 |
| 予約 API の認可（状態・他人の予約・`sending` の取り消し） | 結合テスト | AC-06, AC-09 |
| 管理 API の認可、却下で `scheduled` が消えること、全体枠 | 結合テスト | AC-07, AC-12 |
| ID トークン検証・セッション | 結合テスト。LINE の verify はモック | NFR-02 |
| CSRF 検査 | 結合テスト | NFR-04 |
| 送信処理（成功・再送・失敗・二重起動・401・月間 429・active 以外を送らない） | 結合テスト。LINE の push はモック。時刻は `scheduledTime` | AC-01〜03, AC-10, NFR-06 |
| 退会で予約が消える。管理者と `rejected` は退会できない | 結合テスト | AC-11 |
| 画面（フォーム・一覧・状態ごとの表示） | コンポーネントテスト | FR-05, FR-06, FR-14 |
| スマホ表示 | 375px でスクリーンショット確認 | NFR-10 |
| 実機 | 本番デプロイ後、LINE のメニューから開いて 2 分後の予約を作り、届くことを確認 | AC-01, AC-04 |

テストは Vitest と `@cloudflare/vitest-plugin` で行う。カバレッジ 80% 以上（NFR-11）。

## 11. 要件との対応

| 要件 | 仕様の該当箇所 |
| --- | --- |
| FR-01, FR-04 | §6, §6.1, §8 |
| FR-02, FR-03 | §7 |
| FR-05, FR-06 | §6, §8 |
| FR-07〜09 | §5.1, §9 |
| FR-10, FR-11, FR-17 | §3.1, §6, §8 |
| FR-12〜14 | §2, §4, §6.1, §8 |
| FR-15 | §3.1, §6 |
| FR-16 | §5.2 |
| NFR-01, NFR-12 | §2, §7 |
| NFR-02 | §5.1 |
| NFR-03 | §6 |
| NFR-04 | §5.2 |
| NFR-05, NFR-06 | §7 |
| NFR-07, NFR-08 | §1, §2, §6, §7 |
| NFR-09 | §9 |
| NFR-10 | §8 |
| NFR-11 | §10 |
