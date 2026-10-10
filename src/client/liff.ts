import liff from "@line/liff";

export async function initLiff(liffId: string): Promise<void> {
  await liff.init({ liffId });
}

export function liffInClient(): boolean {
  return liff.isInClient();
}

export function liffLoggedIn(): boolean {
  return liff.isLoggedIn();
}

export function liffStartLogin(): void {
  liff.login();
}

export function liffEndLogin(): void {
  liff.logout();
}

export function liffIdToken(): string | null {
  return liff.getIDToken();
}

export async function liffFriendFlag(): Promise<boolean | null> {
  try {
    const status = await liff.getFriendship();
    return status.friendFlag;
  } catch {
    return null;
  }
}

export async function liffAskFriend(): Promise<void> {
  await liff.requestFriendship();
}
