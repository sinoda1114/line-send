import { Hono } from "hono";
import type { AppEnv } from "./http";
import { csrf } from "./middleware/csrf";
import { requireSession } from "./middleware/session";
import { getMe } from "./routes/me";
import { createSession, deleteSession } from "./routes/session";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => {
  return c.json({ success: true, data: { ok: true }, error: null });
});

app.post("/api/session", csrf, createSession);
app.delete("/api/session", csrf, requireSession, deleteSession);
app.get("/api/me", requireSession, getMe);

export default app;
