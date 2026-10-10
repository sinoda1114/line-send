import { Button, Stack, Text } from "@mantine/core";

type UserStatus = "pending" | "active" | "rejected";

function statusLabel(status: UserStatus): string {
  switch (status) {
    case "pending":
      return "申請中";
    case "active":
      return "承認済み";
    case "rejected":
      return "却下済み";
    default: {
      const neverStatus: never = status;
      throw new Error(neverStatus);
    }
  }
}

function showApprove(status: UserStatus): boolean {
  switch (status) {
    case "pending":
    case "rejected":
      return true;
    case "active":
      return false;
    default: {
      const neverStatus: never = status;
      throw new Error(neverStatus);
    }
  }
}

function showReject(status: UserStatus, id: string, viewerId: string): boolean {
  if (id === viewerId) {
    return false;
  }
  switch (status) {
    case "pending":
    case "active":
      return true;
    case "rejected":
      return false;
    default: {
      const neverStatus: never = status;
      throw new Error(neverStatus);
    }
  }
}

export function AdminPage(props: {
  users: readonly {
    id: string;
    displayName: string;
    status: UserStatus;
    monthCount: number;
  }[];
  activeCount: number;
  monthlyLimit: number;
  globalLimit: number;
  viewerId: string;
  notice: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const approveBlocked = (props.activeCount + 1) * props.monthlyLimit > props.globalLimit;
  return (
    <Stack gap="md">
      <Text>{`承認後の人数 × 月間上限が ${props.globalLimit} を超える承認はできません`}</Text>
      {props.notice === null ? null : <Text>{props.notice}</Text>}
      <Stack gap="md">
        {props.users.map((user) => (
          <Stack key={user.id} gap="xs">
            <Text>{user.displayName}</Text>
            <Text>{statusLabel(user.status)}</Text>
            <Text>{`今月 ${user.monthCount} 件`}</Text>
            {showApprove(user.status) ? (
              <Button
                type="button"
                fullWidth
                disabled={approveBlocked}
                onClick={() => {
                  props.onApprove(user.id);
                }}
              >
                {`${user.displayName}を承認`}
              </Button>
            ) : null}
            {showReject(user.status, user.id, props.viewerId) ? (
              <Button
                type="button"
                fullWidth
                onClick={() => {
                  props.onReject(user.id);
                }}
              >
                {`${user.displayName}を却下`}
              </Button>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
