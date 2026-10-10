import { Button, Stack, Text } from "@mantine/core";

export function FriendBanner({ onAdd }: { onAdd: () => void }) {
  return (
    <Stack gap="xs">
      <Text>公式アカウントを友だち追加してください</Text>
      <Button type="button" fullWidth onClick={onAdd}>
        友だち追加
      </Button>
    </Stack>
  );
}
