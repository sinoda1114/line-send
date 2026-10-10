import { Button, Stack, Text } from "@mantine/core";

export function AccountMenu({
  displayName,
  onLogout,
}: {
  displayName: string;
  onLogout: () => void;
}) {
  return (
    <Stack gap="xs">
      <Text>{displayName}</Text>
      <Button type="button" fullWidth onClick={onLogout}>
        ログアウト
      </Button>
    </Stack>
  );
}
