import { Button, Container, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createSession, deleteSession, getMe, type Me } from "./api";
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
import { RemindersPage } from "./pages/RemindersPage";
import { StatusPage } from "./pages/StatusPage";

type Screen =
  | { kind: "loading" }
  | { kind: "unset" }
  | { kind: "redirect" }
  | { kind: "error"; message: string }
  | { kind: "loggedOut" }
  | { kind: "ready"; me: Me; friendFlag: boolean | null };

function readyBody(me: Me, onMe: (next: Me) => void) {
  switch (me.user.status) {
    case "pending":
      return <StatusPage message="承認待ちです" />;
    case "rejected":
      return <StatusPage message="利用できません" />;
    case "active":
      return <RemindersPage me={me} onMe={onMe} />;
    default: {
      const neverStatus: never = me.user.status;
      return neverStatus;
    }
  }
}

export function App({ liffId }: { liffId: string }) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [logoutError, setLogoutError] = useState<string | null>(null);
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
              onLogout={() => {
                void logout();
              }}
            />
          ) : null}
          {screen.kind === "ready" && logoutError !== null ? <Text>{logoutError}</Text> : null}
          {body}
        </Stack>
      </Container>
    </main>
  );
}
