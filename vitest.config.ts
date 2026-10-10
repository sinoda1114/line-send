import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

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
                bindings: { TEST_MIGRATIONS: migrations },
              },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.ts"],
          exclude: [
            ...configDefaults.exclude,
            "test/worker/apply-migrations.ts",
            "test/worker/**/*.d.ts",
          ],
          setupFiles: ["./test/worker/apply-migrations.ts"],
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
