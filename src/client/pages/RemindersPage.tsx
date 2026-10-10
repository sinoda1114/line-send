import { Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  createReminder,
  deleteReminder,
  getMe,
  listReminders,
  type Failure,
  type Me,
  type Reminder,
} from "../api";
import { ReminderForm } from "../components/ReminderForm";
import { ReminderList } from "../components/ReminderList";

type MeResult = Awaited<ReturnType<typeof getMe>>;

type RefreshResult =
  | { status: "stale" }
  | { status: "list-failed"; message: string }
  | { status: "ready"; upcoming: Reminder[]; history: Reminder[]; me: MeResult | null };

function withCreated(reminders: Reminder[], created: Reminder): Reminder[] {
  if (reminders.some((item) => item.id === created.id)) {
    return reminders;
  }
  return [...reminders, created].sort((left, right) => {
    const byTime = left.sendAt.localeCompare(right.sendAt);
    if (byTime !== 0) {
      return byTime;
    }
    return left.id.localeCompare(right.id);
  });
}

export function RemindersPage({
  me,
  initialSendAt,
  onMe,
}: {
  me: Me;
  initialSendAt?: string;
  onMe: (me: Me) => void;
}) {
  const [upcoming, setUpcoming] = useState<Reminder[]>([]);
  const [history, setHistory] = useState<Reminder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listsReady, setListsReady] = useState(false);
  const generation = useRef(0);

  async function refresh(includeMe: boolean): Promise<RefreshResult> {
    const ticket = ++generation.current;
    const [upcoming, history, me] = await Promise.all([
      listReminders("upcoming"),
      listReminders("history"),
      includeMe ? getMe() : Promise.resolve(null),
    ]);
    if (ticket !== generation.current) {
      return { status: "stale" };
    }
    if (!upcoming.ok) {
      return { status: "list-failed", message: upcoming.message };
    }
    if (!history.ok) {
      return { status: "list-failed", message: history.message };
    }
    return {
      status: "ready",
      upcoming: upcoming.data.reminders,
      history: history.data.reminders,
      me,
    };
  }

  function showLists(upcoming: Reminder[], history: Reminder[], me: MeResult | null): void {
    setUpcoming(upcoming);
    setHistory(history);
    setListsReady(true);
    if (me !== null && !me.ok) {
      setLoadError(me.message);
      return;
    }
    setLoadError(null);
    if (me !== null && me.ok) {
      onMe(me.data);
    }
  }

  useEffect(() => {
    void (async () => {
      const result = await refresh(false);
      switch (result.status) {
        case "stale":
          return;
        case "list-failed":
          setLoadError(result.message);
          return;
        case "ready":
          showLists(result.upcoming, result.history, null);
          return;
        default: {
          const neverResult: never = result;
          return neverResult;
        }
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, []);

  async function handleCreate(body: {
    text: string;
    sendAt: string;
  }): Promise<{ ok: true } | Failure> {
    const created = await createReminder(body.text, body.sendAt);
    if (!created.ok) {
      return created;
    }
    const result = await refresh(true);
    switch (result.status) {
      case "stale":
        return { ok: true };
      case "list-failed":
        setLoadError(result.message);
        setUpcoming((current) => withCreated(current, created.data.reminder));
        setListsReady(true);
        return { ok: true };
      case "ready":
        showLists(withCreated(result.upcoming, created.data.reminder), result.history, result.me);
        return { ok: true };
      default: {
        const neverResult: never = result;
        return neverResult;
      }
    }
  }

  function markPending(id: string, pending: boolean): void {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function handleDelete(id: string): Promise<void> {
    markPending(id, true);
    const ticket = generation.current;
    try {
      const deleted = await deleteReminder(id);
      if (!deleted.ok) {
        if (ticket === generation.current) {
          setLoadError(deleted.message);
        }
        return;
      }
      setUpcoming((current) => current.filter((item) => item.id !== id));
      const result = await refresh(true);
      switch (result.status) {
        case "stale":
          return;
        case "list-failed":
          setLoadError(result.message);
          return;
        case "ready":
          showLists(
            result.upcoming.filter((item) => item.id !== id),
            result.history,
            result.me,
          );
          return;
        default: {
          const neverResult: never = result;
          return neverResult;
        }
      }
    } finally {
      markPending(id, false);
    }
  }

  return (
    <Stack gap="md">
      <ReminderForm usage={me.usage} initialSendAt={initialSendAt} onCreate={handleCreate} />
      {loadError === null ? null : <Text>{loadError}</Text>}
      <ReminderList
        upcoming={upcoming}
        history={history}
        pendingIds={pendingIds}
        ready={listsReady}
        onDelete={(id) => {
          void handleDelete(id);
        }}
      />
    </Stack>
  );
}
