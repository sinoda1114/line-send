const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export type PushOutcome =
  | { type: "sent" }
  | { type: "retry"; reason: "network" | "http_429" | "http_5xx" }
  | { type: "fail"; reason: string }
  | { type: "stop" };

export async function pushMessage(
  token: string,
  to: string,
  text: string,
  retryKey: string,
): Promise<PushOutcome> {
  let response: Response;
  try {
    // workerd は redirect: "error" を拒否する。manual なら 3xx を自分で受ける。
    response = await fetch(LINE_PUSH_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-line-retry-key": retryKey,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text }],
      }),
    });
  } catch {
    return { type: "retry", reason: "network" };
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { type: "retry", reason: "network" };
  }

  if (response.status === 200 || response.status === 409) {
    await response.body?.cancel();
    return { type: "sent" };
  }

  const message = await lineMessage(response);
  if (response.status === 401) {
    return { type: "stop" };
  }
  if (response.status === 429) {
    if (message === "You have reached your monthly limit.") {
      return { type: "stop" };
    }
    return { type: "retry", reason: "http_429" };
  }
  if (response.status >= 500) {
    return { type: "retry", reason: "http_5xx" };
  }
  return { type: "fail", reason: `http_${response.status}` };
}

async function lineMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    return "";
  }
  return "";
}
