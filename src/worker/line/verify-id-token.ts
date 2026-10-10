const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const MAX_BODY_BYTES = 8192;
const SUB_PATTERN = /^U[0-9a-fA-F]{32}$/;
const FALLBACK_NAME = "LINEユーザー";

export type VerifiedIdToken = {
  sub: string;
  displayName: string;
};

export async function verifyIdToken(
  clientId: string,
  idToken: string,
  nowMs: number,
): Promise<VerifiedIdToken | null> {
  if (clientId.length === 0) {
    return null;
  }
  let response: Response;
  try {
    // workerd は redirect: "error" を拒否する。manual なら 3xx を自分で落とす。
    response = await fetch(VERIFY_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: clientId,
      }),
    });
  } catch {
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  const text = await readCapped(response, MAX_BODY_BYTES);
  if (text === null) {
    return null;
  }
  return parseVerified(text, clientId, nowMs);
}

function parseVerified(
  text: string,
  clientId: string,
  nowMs: number,
): VerifiedIdToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const aud = record.aud;
  const exp = record.exp;
  const sub = record.sub;
  if (typeof aud !== "string" || aud !== clientId) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp * 1000 <= nowMs) {
    return null;
  }
  if (typeof sub !== "string" || !SUB_PATTERN.test(sub)) {
    return null;
  }
  return { sub, displayName: displayNameFrom(record.name) };
}

function displayNameFrom(name: unknown): string {
  if (typeof name === "string" && name.length > 0 && name.length <= 100) {
    return name;
  }
  return FALLBACK_NAME;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await cancelReader(reader);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    await cancelReader(reader);
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    return;
  }
}
