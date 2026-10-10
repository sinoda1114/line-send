import { Button, Container, Stack, Tabs, Text } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  approveUser,
  createSession,
  deleteMe,
  deleteSession,
  getMe,
  listAdminUsers,
  rejectUser,
  type AdminList,
  type Failure,
  type Me,
  type PublicUser,
} from "./api";
import { AccountMenu } from "./components/AccountMenu";
import { FriendBanner } from "./components/FriendBanner";
import "./dates";
import {
  initLiff,
  liffAskFriend,
  liffEndLogin,
  liffFriendFlag,
  liffIdToken,
  liffInClient,
  liffLoggedIn,
  liffStartLogin,
} from "./liff";
import { AdminPage } from "./pages/AdminPage";
import { RemindersPage } from "./pages/RemindersPage";
import { StatusPage } from "./pages/StatusPage";

type AdminView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: AdminList };

function AdminLoader({ viewerId }: { viewerId: string }) {
  const [view, setView] = useState<AdminView>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);

  async function load(): Promise<void> {
    const ticket = ++generation.current;
    const listed = await listAdminUsers();
    if (ticket !== generation.current) {
      return;
    }
    if (!listed.ok) {
      setView({ kind: "error", message: listed.message });
      return;
    }
    setView({ kind: "ready", data: listed.data });
  }

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, []);

  async function decide(
    id: string,
    run: (userId: string) => Promise<{ ok: true; data: { ok: boolean } } | Failure>,
  ): Promise<void> {
    const ticket = generation.current;
    const result = await run(id);
    if (!result.ok) {
      if (ticket !== generation.current) {
        return;
      }
      setNotice(result.message);
      return;
    }
    if (ticket === generation.current) {
      setNotice(null);
    }
    await load();
  }

  switch (view.kind) {
    case "loading":
      return <Text>読み込み中</Text>;
    case "error":
      return <Text>{view.message}</Text>;
    case "ready":
      return (
        <AdminPage
          users={view.data.users}
          activeCount={view.data.activeCount}
          monthlyLimit={view.data.monthlyLimit}
          globalLimit={view.data.globalLimit}
          viewerId={viewerId}
          notice={notice}
          onApprove={(id) => {
            void decide(id, approveUser);
          }}
          onReject={(id) => {
            void decide(id, rejectUser);
          }}
        />
      );
    default: {
      const neverView: never = view;
      return neverView;
    }
  }
}

function ActiveHome({ me, onMe }: { me: Me; onMe: (next: Me) => void }) {
  if (!me.user.isAdmin) {
    return <RemindersPage me={me} onMe={onMe} />;
  }
  return (
    <Tabs defaultValue="reserve">
      <Tabs.List grow>
        <Tabs.Tab value="reserve">予約</Tabs.Tab>
        <Tabs.Tab value="admin">管理</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="reserve">
        <RemindersPage me={me} onMe={onMe} />
      </Tabs.Panel>
      <Tabs.Panel value="admin">
        <AdminLoader viewerId={me.user.id} />
      </Tabs.Panel>
    </Tabs>
  );
}

type Screen =
  | { kind: "loading" }
  | { kind: "unset" }
  | { kind: "redirect" }
  | { kind: "error"; message: string }
  | { kind: "loggedOut" }
  | { kind: "withdrawn" }
  | { kind: "ready"; me: Me; friendFlag: boolean | null };

function canWithdraw(user: PublicUser): boolean {
  return !user.isAdmin && (user.status === "pending" || user.status === "active");
}

function readyBody(me: Me, onMe: (next: Me) => void) {
  switch (me.user.status) {
    case "pending":
      return <StatusPage message="承認待ちです" />;
    case "rejected":
      return <StatusPage message="利用できません" />;
    case "active":
      return <ActiveHome me={me} onMe={onMe} />;
    default: {
      const neverStatus: never = me.user.status;
      return neverStatus;
    }
  }
}

export function App({ liffId }: { liffId: string }) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const friendTicket = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (liffId === "") {
        if (!cancelled) {
          setScreen({ kind: "unset" });
        }
        return;
      }
      try {
        await initLiff(liffId);
        if (cancelled) {
          return;
        }
        if (!liffLoggedIn()) {
          if (liffInClient()) {
            setScreen({ kind: "error", message: "ログインできません" });
            return;
          }
          liffStartLogin();
          setScreen({ kind: "redirect" });
          return;
        }
        const idToken = liffIdToken();
        if (idToken === null || idToken === "") {
          setScreen({ kind: "error", message: "ログインできません" });
          return;
        }
        const session = await createSession(idToken);
        if (cancelled) {
          return;
        }
        if (!session.ok) {
          setScreen({ kind: "error", message: session.message });
          return;
        }
        const me = await getMe();
        const friendFlag = await liffFriendFlag();
        if (cancelled) {
          return;
        }
        if (!me.ok) {
          setScreen({ kind: "error", message: me.message });
          return;
        }
        setScreen({ kind: "ready", me: me.data, friendFlag });
      } catch {
        if (!cancelled) {
          setScreen({ kind: "error", message: "ログインできません" });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [liffId]);

  function updateMe(me: Me): void {
    setScreen((current) => {
      if (current.kind !== "ready") {
        return current;
      }
      return { ...current, me };
    });
  }

  async function addFriend(): Promise<void> {
    const ticket = ++friendTicket.current;
    try {
      await liffAskFriend();
    } catch {
      return;
    }
    const friendFlag = await liffFriendFlag();
    if (ticket !== friendTicket.current) {
      return;
    }
    setScreen((current) => {
      if (current.kind !== "ready") {
        return current;
      }
      return { ...current, friendFlag };
    });
  }

  async function logout(): Promise<void> {
    const deleted = await deleteSession();
    if (!deleted.ok) {
      setLogoutError(deleted.message);
      return;
    }
    liffEndLogin();
    setLogoutError(null);
    setScreen({ kind: "loggedOut" });
  }

  async function withdraw(): Promise<void> {
    const deleted = await deleteMe();
    if (!deleted.ok) {
      setWithdrawError(deleted.message);
      return;
    }
    liffEndLogin();
    setWithdrawError(null);
    setScreen({ kind: "withdrawn" });
  }

  function loginAgain(): void {
    if (liffInClient()) {
      setScreen({ kind: "error", message: "ログインできません" });
      return;
    }
    liffStartLogin();
  }

  let body: ReactNode;
  switch (screen.kind) {
    case "loading":
      body = <Text>読み込み中</Text>;
      break;
    case "unset":
      body = <Text>LIFF ID が未設定です</Text>;
      break;
    case "redirect":
      body = <Text>ログインしています</Text>;
      break;
    case "error":
      body = <Text>{screen.message}</Text>;
      break;
    case "loggedOut":
      body = (
        <Stack gap="xs">
          <Text>ログアウトしました</Text>
          <Button type="button" fullWidth onClick={loginAgain}>
            ログイン
          </Button>
        </Stack>
      );
      break;
    case "withdrawn":
      body = <Text>退会しました</Text>;
      break;
    case "ready":
      body = readyBody(screen.me, updateMe);
      break;
    default: {
      const neverScreen: never = screen;
      body = neverScreen;
      break;
    }
  }

  return (
    <main>
      <Container fluid px="md">
        <Stack gap="md">
          {screen.kind === "ready" && screen.friendFlag === false ? (
            <FriendBanner
              onAdd={() => {
                void addFriend();
              }}
            />
          ) : null}
          {screen.kind === "ready" ? (
            <AccountMenu
              displayName={screen.me.user.displayName}
              canWithdraw={canWithdraw(screen.me.user)}
              onLogout={() => {
                void logout();
              }}
              onWithdraw={() => {
                void withdraw();
              }}
            />
          ) : null}
          {screen.kind === "ready" && logoutError !== null ? <Text>{logoutError}</Text> : null}
          {screen.kind === "ready" && withdrawError !== null ? <Text>{withdrawError}</Text> : null}
          {body}
        </Stack>
      </Container>
    </main>
  );
}
