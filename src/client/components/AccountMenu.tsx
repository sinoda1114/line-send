import { Button, Stack, Text } from "@mantine/core";
import { useState } from "react";

export function AccountMenu({
  displayName,
  canWithdraw,
  onLogout,
  onWithdraw,
}: {
  displayName: string;
  canWithdraw: boolean;
  onLogout: () => void;
  onWithdraw: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Stack gap="xs">
      <Text>{displayName}</Text>
      <Button type="button" fullWidth onClick={onLogout}>
        ログアウト
      </Button>
      {canWithdraw ? (
        <Button
          type="button"
          fullWidth
          onClick={() => {
            setConfirming(true);
          }}
        >
          退会
        </Button>
      ) : null}
      {confirming ? (
        <dialog open>
          <p>退会すると予約も消えます</p>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => {
              onWithdraw();
            }}
          >
            退会する
          </button>
        </dialog>
      ) : null}
    </Stack>
  );
}
