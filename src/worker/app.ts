import { Hono } from "hono";
import type { AppEnv } from "./http";
import { csrf } from "./middleware/csrf";
import { requireActive, requireAdmin } from "./middleware/guards";
import { requireSession } from "./middleware/session";
import { approveUser, listUsers, rejectUser } from "./routes/admin";
import { getMe } from "./routes/me";
import { createReminder, deleteReminder, listReminders } from "./routes/reminders";
import { createSession, deleteSession } from "./routes/session";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => {
  return c.json({ success: true, data: { ok: true }, error: null });
});

app.post("/api/session", csrf, createSession);
app.delete("/api/session", csrf, requireSession, deleteSession);
app.get("/api/me", requireSession, getMe);
app.get("/api/reminders", requireSession, requireActive, listReminders);
app.post("/api/reminders", csrf, requireSession, requireActive, createReminder);
app.delete("/api/reminders/:id", csrf, requireSession, requireActive, deleteReminder);
app.get("/api/admin/users", requireSession, requireAdmin, listUsers);
app.post("/api/admin/users/:id/approve", csrf, requireSession, requireAdmin, approveUser);
app.post("/api/admin/users/:id/reject", csrf, requireSession, requireAdmin, rejectUser);

export default app;
