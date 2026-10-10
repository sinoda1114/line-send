# 03. ストラクチャ構造

- 対象: line-send
- 作成日: 2026-10-10
- 改訂: 2026-10-10（テストパッケージ、CI、npm の install script、Preview の分離を確定）
- 関連文書: [01_REQUIREMENTS.md](01_REQUIREMENTS.md) / [02_SPECIFICATION.md](02_SPECIFICATION.md)

## 1. ディレクトリ構成

```
line-send/
├── docs/                          # 本文書群
├── migrations/
│   └── 0001_init.sql              # D1 スキーマ（02 §4 を承認済み）
├── public/
│   ├── manifest.webmanifest       # PWA マニフェスト
│   └── icons/                     # PWA アイコン（192px / 512px）
├── src/
│   ├── shared/
│   │   ├── schema.ts              # Zod スキーマ（予約入力・API レスポンス）
│   │   └── time.ts                # 日本時間 ⇔ UTC、分単位の丸め、send_month 算出
│   ├── worker/
│   │   ├── index.ts               # エントリ。fetch → Hono、scheduled → 送信処理
│   │   ├── app.ts                 # Hono アプリの組み立て（ルート・ミドルウェア）
│   │   ├── http.ts                # 共通レスポンス形・エラーコード
│   │   ├── middleware/
│   │   │   ├── session.ts         # セッション Cookie の読み取り → 利用者をコンテキストへ
│   │   │   ├── guards.ts          # requireActive / requireAdmin
│   │   │   └── csrf.ts            # Content-Type と Origin の検査
│   │   ├── routes/
│   │   │   ├── session.ts         # POST/DELETE /api/session
│   │   │   ├── me.ts              # GET/DELETE /api/me
│   │   │   ├── reminders.ts       # /api/reminders
│   │   │   └── admin.ts           # /api/admin/*
│   │   ├── services/
│   │   │   └── dispatch.ts        # Cron の送信処理（1件確保 → push → 状態更新）
│   │   ├── line/
│   │   │   ├── verify-id-token.ts # LINE Login の ID トークン検証
│   │   │   └── push.ts            # Messaging API の push（Retry Key 付き）
│   │   ├── auth/
│   │   │   └── session-cookie.ts  # HMAC 署名・検証、Cookie の発行・破棄
│   │   └── db/
│   │       ├── users.ts           # users の読み書き
│   │       └── reminders.ts       # reminders の読み書き（上限付き挿入・確保）
│   └── client/
│       ├── main.tsx               # エントリ。MantineProvider
│       ├── App.tsx                # 状態（pending / active / rejected / admin）で画面切替
│       ├── liff.ts                # liff.init、ログイン、ID トークン取得、友だち状態
│       ├── api.ts                 # /api の fetch ラッパー（型付き）
│       ├── pages/
│       │   ├── RemindersPage.tsx  # 予約フォーム + 送信待ち + 履歴
│       │   ├── StatusPage.tsx     # 申請中・却下の表示
│       │   └── AdminPage.tsx      # 承認・却下、利用者一覧
│       └── components/
│           ├── ReminderForm.tsx   # 文面 + DateTimePicker、残り枠表示
│           ├── ReminderList.tsx   # 一覧と取り消し
│           ├── FriendBanner.tsx   # 友だち未追加の案内
│           └── AccountMenu.tsx    # ログアウト・退会（確認ダイアログ）
├── test/
│   ├── worker/                    # @cloudflare/vitest-plugin（D1 + LINE API モック）
│   └── client/                    # コンポーネントテスト
├── index.html                     # 画面の HTML（Vite のエントリ）
├── vite.config.ts                 # React + @cloudflare/vite-plugin
├── vitest.config.ts
├── wrangler.jsonc                 # D1、本番だけの Cron、静的配信、var。型は wrangler types
├── tsconfig.json                  # 共通設定（worker / client で分割参照）
├── package.json / package-lock.json
├── .npmrc                         # save-exact。ignore-scripts は付けない
├── .dev.vars.example              # ローカル用 secret の雛形（値は空）
└── .github/
    ├── workflows/
    │   ├── ci.yml                 # 型検査、テスト、カバレッジ
    │   └── deploy.yml             # main だけ。マイグレーション適用と wrangler deploy
    └── dependabot.yml             # npm、weekly
```

`src/worker/env.ts` は置かない。バインディング型は `wrangler types` の生成物を使う。

## 2. ファイル責務と仕様の対応

| 仕様（02） | 担当ファイル |
| --- | --- |
| §1 構成 | `vite.config.ts`、`wrangler.jsonc`、`src/worker/index.ts`、`src/worker/app.ts` |
| §2 設定値 | `wrangler.jsonc`、`.dev.vars.example`、生成された型 |
| §3 状態 | `src/worker/db/users.ts`、`src/worker/db/reminders.ts`、`src/worker/services/dispatch.ts` |
| §4 データ構造 | `migrations/0001_init.sql`、`src/worker/db/*` |
| §5.1 ログイン | `src/client/liff.ts`、`src/worker/routes/session.ts`、`src/worker/line/verify-id-token.ts` |
| §5.2 セッション・CSRF | `src/worker/auth/session-cookie.ts`、`src/worker/middleware/*` |
| §6 JSON API | `src/worker/routes/*`、`src/worker/http.ts`、`src/client/api.ts` |
| §6.1 予約の検証 | `src/shared/schema.ts`、`src/shared/time.ts`、`src/worker/db/reminders.ts` |
| §7 送信処理 | `src/worker/services/dispatch.ts`、`src/worker/line/push.ts` |
| §8 画面 | `src/client/*`、`public/manifest.webmanifest` |
| §9 配置先 | `wrangler.jsonc`、`.github/workflows/ci.yml`、`.github/workflows/deploy.yml` |
| §10 検証 | `test/*`、`vitest.config.ts` |

## 3. 依存パッケージ

| パッケージ | 用途 | 区分 |
| --- | --- | --- |
| `hono` | API のルーティング・Cookie | 本番 |
| `zod` | 入力検証（画面と API で共有） | 本番 |
| `react` / `react-dom` | 画面 | 本番 |
| `@mantine/core` / `@mantine/hooks` / `@mantine/dates` / `dayjs` | UI 部品、日時入力（`@mantine/dates` は `dayjs` が必要） | 本番 |
| `@line/liff` | LIFF SDK | 本番 |
| `vite` / `@vitejs/plugin-react` / `@cloudflare/vite-plugin` | ビルド・開発サーバー | 開発 |
| `wrangler` | デプロイ・D1 マイグレーション・型生成 | 開発 |
| `typescript` | 型検査 | 開発 |
| `vitest` / `@cloudflare/vitest-plugin` / `@testing-library/react` | テスト | 開発 |

追加時は `save-exact` で版を固定する。`ignore-scripts` は付けない。workerd と esbuild は導入時のスクリプトが必要である。ネイティブビルドが必要なパッケージは含まない。

`@cloudflare/vitest-pool-workers` は使わない。後継は `@cloudflare/vitest-plugin` である。

## 4. 実装の優先順位

リスクの高い送信まわりを先に動かし、画面は後から載せる。

| 順 | 内容 | 完了の目安 | 対応 |
| --- | --- | --- | --- |
| 1 | 土台: Vite + Worker の雛形、`.npmrc`、CI、Dependabot | CI が緑、空の画面と `/api/health` が返る | NFR-09, NFR-11 |
| 2 | D1 マイグレーション（02 §4） | ローカル D1 にテーブルができる。退会の CASCADE をテストする | §4 |
| 3 | 送信処理: `line/push.ts` と `services/dispatch.ts` | テストで成功・再送・失敗・二重起動・401・月間 429 が通る。1 件の CPU 時間を測る | FR-02, FR-03, NFR-05, NFR-06, NFR-07 |
| 4 | 本人確認: ID トークン検証、セッション、`/api/session`、`/api/me` | テストで認証・CSRF が通る | NFR-02, NFR-04 |
| 5 | 予約 API: 作成（上限付き）・一覧・取り消し | テストで認可・上限・他人の予約が通る | FR-01, FR-05, FR-06, FR-12 |
| 6 | 画面: LIFF 初期化、予約画面（Mantine）、状態別表示、友だち案内 | 375px で予約の作成・取り消しができる | FR-07〜09, FR-14, NFR-10 |
| 7 | 管理: 承認・却下 API と画面。全体枠 180。却下で送信待ちを削除 | 友達のアカウントで申請 → 承認 → 予約できる | FR-10, FR-11, FR-17 |
| 8 | 退会、PWA マニフェスト | 退会で予約が消える。管理者と却下済みは退会できない。ホーム画面に追加できる | FR-08, FR-15 |
| 9 | 本番: LINE 側設定（LIFF・リッチメニュー）、secret 登録、デプロイ | LINE のメニューから開いて予約が届く | AC-01, AC-04 |

各段階は feature ブランチと PR で進める。段階 1 の前に、この文書群を main に入れる。

## 5. CI

このリポジトリに再利用ワークフロー `ci-standard` は無い。次の 2 本をリポジトリ内に書く。

- `ci.yml`: pull request と push で、型検査とテストを実行する。カバレッジが 80% 未満なら失敗させる。
- `deploy.yml`: `main` への push だけで動かす。本番 D1 にマイグレーションを適用してから `wrangler deploy` する。Preview 用のワークフローを足す場合も、Cron と本番トークンは付けない。

## 6. 篠田さんの作業（LINE 側の準備）

段階 3 の前までに必要。

1. LINE Developers でプロバイダーを作る（既存があればそれを使う）。
2. 同じプロバイダーに Messaging API チャネルを作り、長期のチャネルアクセストークンを発行する。
3. 同じプロバイダーに LINE ログインチャネルを作り、チャネル ID を控える。
4. LINE ログインチャネルに LIFF アプリを作る（本番用と開発用の 2 つ）。サイズは Full、scope は `openid` と `profile`、友だち追加オプションを有効にする。
5. LINE ログインチャネルの「リンクされた LINE 公式アカウント」に 2 の公式アカウントを設定する。
6. 段階 9 で LIFF アプリを公開し、公式アカウントのリッチメニューに LIFF の URL を設定する。

## 7. 文書間の整合チェック

- 01 の機能要件 FR-01〜17 と非機能要件 NFR-01〜12 は、すべて 02 §11 で仕様に対応づけた。
- 02 の各節は、すべて本書 §2 で担当ファイルに対応づけた。
- 用語は「予約」「送信待ち（`scheduled`）」「送信中（`sending`）」「送信済み（`sent`）」「失敗（`failed`）」「管理者」「利用者」で統一した。
- 対象外（HTTP API、繰り返し、編集、他人への送信、ネイティブアプリ、承認通知）は 01 §3.2 に限定し、02・03 の対象機能には含めていない。
