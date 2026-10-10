import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => {
  return c.json({ success: true, data: { ok: true }, error: null });
});

export default app;
