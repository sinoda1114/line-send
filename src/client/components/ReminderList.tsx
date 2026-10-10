import { Button, Stack, Tabs, Text } from "@mantine/core";
import type { Reminder, ReminderStatus } from "../api";
import { formatTokyoMinute } from "./tokyoTime";

function statusText(status: ReminderStatus): string | null {
  switch (status) {
    case "scheduled":
      return null;
    case "sending":
      return "送信中";
    case "sent":
      return "送信済み";
    case "failed":
      return "失敗";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function ReminderItem({
  reminder,
  pending,
  onDelete,
}: {
  reminder: Reminder;
  pending: boolean;
  onDelete: (id: string) => void;
}) {
  const label = statusText(reminder.status);
  return (
    <Stack gap="xs">
      <Text style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{reminder.text}</Text>
      <Text>{formatTokyoMinute(reminder.sendAt)}</Text>
      {label === null ? null : <Text>{label}</Text>}
      {reminder.status === "scheduled" ? (
        <Button type="button" fullWidth disabled={pending} onClick={() => onDelete(reminder.id)}>
          取り消す
        </Button>
      ) : null}
    </Stack>
  );
}

function ReminderItems({
  reminders,
  empty,
  ready,
  pendingIds,
  onDelete,
}: {
  reminders: Reminder[];
  empty: string;
  ready: boolean;
  pendingIds: ReadonlySet<string>;
  onDelete: (id: string) => void;
}) {
  if (!ready) {
    return null;
  }
  if (reminders.length === 0) {
    return <Text>{empty}</Text>;
  }
  return (
    <Stack gap="md">
      {reminders.map((reminder) => (
        <ReminderItem
          key={reminder.id}
          reminder={reminder}
          pending={pendingIds.has(reminder.id)}
          onDelete={onDelete}
        />
      ))}
    </Stack>
  );
}

export function ReminderList({
  upcoming,
  history,
  pendingIds,
  onDelete,
  ready = true,
}: {
  upcoming: Reminder[];
  history: Reminder[];
  pendingIds: ReadonlySet<string>;
  onDelete: (id: string) => void;
  ready?: boolean;
}) {
  return (
    <Tabs defaultValue="upcoming">
      <Tabs.List grow>
        <Tabs.Tab value="upcoming">送信待ち</Tabs.Tab>
        <Tabs.Tab value="history">履歴</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="upcoming" pt="sm">
        <ReminderItems
          reminders={upcoming}
          empty="送信待ちはありません"
          ready={ready}
          pendingIds={pendingIds}
          onDelete={onDelete}
        />
      </Tabs.Panel>
      <Tabs.Panel value="history" pt="sm">
        <ReminderItems
          reminders={history}
          empty="履歴はありません"
          ready={ready}
          pendingIds={pendingIds}
          onDelete={onDelete}
        />
      </Tabs.Panel>
    </Tabs>
  );
}
