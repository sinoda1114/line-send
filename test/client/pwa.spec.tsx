import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = {
  name: "line-send",
  short_name: "line-send",
  lang: "ja",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
  ],
};

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

describe("pwa", () => {
  it("マニフェストはホーム画面へ追加できる項目だけを持つ", () => {
    const parsed: unknown = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
    expect(parsed).toEqual(manifest);
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(manifest.icons.every((icon) => icon.purpose === "any")).toBe(true);
    expect(parsed).not.toHaveProperty("prefer_related_applications");
  });

  it("192px のアイコンは PNG である", () => {
    expect(pngSize("public/icons/icon-192.png")).toEqual({ width: 192, height: 192 });
  });

  it("512px のアイコンは PNG である", () => {
    expect(pngSize("public/icons/icon-512.png")).toEqual({ width: 512, height: 512 });
  });

  it("index.html はマニフェストと既存の入口を残す", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color" content="#ffffff"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/icon-192.png"');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect(html).toContain('src="/src/client/main.tsx"');
  });

  it("Service Worker は置かない", () => {
    expect(existsSync("public/sw.js")).toBe(false);
    const sources = sourceFiles("src");
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) {
      expect(readFileSync(path, "utf8").includes("serviceWorker")).toBe(false);
    }
  });
});
