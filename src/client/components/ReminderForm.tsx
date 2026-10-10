import { Button, Stack, Text, Textarea } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { useState } from "react";
import { parseReminderBody } from "../../shared/schema";
import { floorUtcMinute } from "../../shared/time";
import type { Failure, Usage } from "../api";
import "../dates";
import { tokyoWallClock } from "./tokyoTime";

const PICKER_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

export function toTokyoSendAt(value: string): string | null {
  const match = PICKER_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }
  return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
}

function remainingCount(usage: Usage): number {
  return Math.max(0, usage.limit - usage.count);
}

export function ReminderForm({
  usage,
  initialSendAt,
  onCreate,
}: {
  usage: Usage;
  initialSendAt?: string;
  onCreate: (body: { text: string; sendAt: string }) => Promise<{ ok: true } | Failure>;
}) {
  const [text, setText] = useState("");
  const [sendAt, setSendAt] = useState<string | null>(initialSendAt ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nowMs = Date.now();
  const earliest = floorUtcMinute(nowMs) + 60_000;
  const latest = new Date(nowMs);
  latest.setUTCFullYear(latest.getUTCFullYear() + 1);
  const minDate = tokyoWallClock(earliest);
  const maxDate = tokyoWallClock(latest.getTime());
  const remaining = remainingCount(usage);

  async function submit(): Promise<void> {
    if (submitting) {
      return;
    }
    if (sendAt === null) {
      setMessage("入力が不正です");
      return;
    }
    const tokyo = toTokyoSendAt(sendAt);
    if (tokyo === null) {
      setMessage("入力が不正です");
      return;
    }
    const draft = parseReminderBody({ text, sendAt: tokyo }, Date.now());
    if (draft === null) {
      setMessage("入力が不正です");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await onCreate({ text: draft.text, sendAt: draft.sendAt });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setText("");
      setSendAt(null);
      setMessage(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack gap="sm">
        <Text>
          今月 {usage.month} の残り {remaining} 件（{usage.count} / {usage.limit}）
        </Text>
        <Textarea
          label="文面"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          w="100%"
        />
        <DateTimePicker
          label="日時"
          dropdownType="modal"
          valueFormat="YYYY-MM-DD HH:mm"
          w="100%"
          clearable
          value={sendAt}
          onChange={setSendAt}
          minDate={minDate === "" ? undefined : minDate}
          maxDate={maxDate === "" ? undefined : maxDate}
        />
        {message === null ? null : <Text>{message}</Text>}
        <Button type="submit" fullWidth disabled={submitting}>
          予約する
        </Button>
      </Stack>
    </form>
  );
}
