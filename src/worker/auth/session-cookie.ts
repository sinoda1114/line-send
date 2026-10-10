import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

const COOKIE_NAME = "session";
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cookieSecure(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  return !(url.protocol === "http:" && url.hostname === "localhost");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey | null> {
  const raw = encoder.encode(secret);
  if (raw.byteLength < 32) {
    return null;
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sealSession(
  secret: string,
  userId: string,
  nowMs: number,
): Promise<string | null> {
  const key = await hmacKey(secret);
  if (key === null) {
    return null;
  }
  const payload = JSON.stringify({
    id: userId,
    exp: Math.floor(nowMs / 1000) + SEVEN_DAYS,
  });
  const payloadBytes = encoder.encode(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signature)}`;
}

export async function openSession(
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ id: string; exp: number } | null> {
  const key = await hmacKey(secret);
  if (key === null) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (payloadPart === undefined || signaturePart === undefined) {
    return null;
  }
  const payloadBytes = decodeBase64Url(payloadPart);
  const signatureBytes = decodeBase64Url(signaturePart);
  if (payloadBytes === null || signatureBytes === null) {
    return null;
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    arrayBuffer(signatureBytes),
    arrayBuffer(payloadBytes),
  );
  if (!verified) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id;
  const exp = record.exp;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp * 1000 <= nowMs) {
    return null;
  }
  return { id, exp };
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAME);
}

export function writeSessionCookie(c: Context, token: string, maxAge: number): void {
  setCookie(c, COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c.req.url),
    maxAge,
  });
}

export function clearSessionCookie(c: Context): void {
  writeSessionCookie(c, "", 0);
}

export const SESSION_MAX_AGE = SEVEN_DAYS;
