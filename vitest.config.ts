import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/worker/**/*.ts", "src/client/**/*.tsx"],
      exclude: ["src/client/main.tsx"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(
              path.join(import.meta.dirname, "migrations"),
            );
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  LINE_CHANNEL_ACCESS_TOKEN: "test-token",
                  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
                  ADMIN_LINE_USER_ID: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  LINE_LOGIN_CHANNEL_ID: "1234567890",
                  APP_ORIGIN: "https://app.example",
                  MONTHLY_LIMIT: "30",
                },
              },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.spec.ts"],
          setupFiles: ["./test/worker/apply-migrations.ts"],
          fileParallelism: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "client",
          environment: "jsdom",
          include: ["test/client/**/*.tsx"],
        },
      },
    ],
  },
});
