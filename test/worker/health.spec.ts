import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("成功の形で返す", async () => {
    const response = await exports.default.fetch("http://example.com/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { ok: true },
      error: null,
    });
  });
});
