export type UserStatus = "pending" | "active" | "rejected";

export type PublicUser = {
  id: string;
  displayName: string;
  status: UserStatus;
  isAdmin: boolean;
};

export type Usage = {
  month: string;
  count: number;
  limit: number;
};

export type Me = {
  user: PublicUser;
  usage: Usage;
};

export type ReminderStatus = "scheduled" | "sending" | "sent" | "failed";

export type Reminder = {
  id: string;
  text: string;
  sendAt: string;
  sendMonth: string;
  status: ReminderStatus;
  sentAt: string | null;
};

export type Failure = { ok: false; message: string };
type Success<T> = { ok: true; data: T };

async function request<T>(path: string, init: RequestInit): Promise<Success<T> | Failure> {
  if (!path.startsWith("/api/")) {
    return { ok: false, message: "通信できません" };
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    return { ok: false, message: "通信できません" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "通信できません" };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "success" in body &&
    body.success === true &&
    "data" in body &&
    typeof body.data === "object" &&
    body.data !== null
  ) {
    return { ok: true, data: body.data as T };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return { ok: false, message: body.error.message };
  }
  return { ok: false, message: "通信できません" };
}

export function createSession(idToken: string): Promise<Success<{ user: PublicUser }> | Failure> {
  return request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
}

export function deleteSession(): Promise<Success<{ ok: boolean }> | Failure> {
  return request("/api/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export function getMe(): Promise<Success<Me> | Failure> {
  return request("/api/me", { method: "GET" });
}

export function deleteMe(): Promise<Success<{ ok: true }> | Failure> {
  return request("/api/me", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function listReminders(
  view: "upcoming" | "history",
): Promise<Success<{ reminders: Reminder[] }> | Failure> {
  return request(`/api/reminders?view=${view}`, { method: "GET" });
}

export function createReminder(
  text: string,
  sendAt: string,
): Promise<Success<{ reminder: Reminder }> | Failure> {
  return request("/api/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sendAt }),
  });
}

export function deleteReminder(id: string): Promise<Success<{ ok: boolean }> | Failure> {
  return request(`/api/reminders/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export type AdminUser = {
  id: string;
  displayName: string;
  status: UserStatus;
  monthCount: number;
};

export type AdminList = {
  users: AdminUser[];
  activeCount: number;
  monthlyLimit: number;
  globalLimit: number;
};

export function listAdminUsers(): Promise<Success<AdminList> | Failure> {
  return request("/api/admin/users", { method: "GET" });
}

export function approveUser(id: string): Promise<Success<{ ok: boolean }> | Failure> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export function rejectUser(id: string): Promise<Success<{ ok: boolean }> | Failure> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}
