import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type Connection = { baseUrl: string; username: string; password: string };

const key = "fox-focus.connection";

function isConnection(value: unknown): value is Connection {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.baseUrl === "string" && typeof record.username === "string" && typeof record.password === "string";
}

// the web build is only a dev preview, so it falls back to localStorage
export async function loadConnection(): Promise<Connection | null> {
  const raw = Platform.OS === "web" ? globalThis.localStorage?.getItem(key) ?? null : await SecureStore.getItemAsync(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isConnection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveConnection(connection: Connection | null): Promise<void> {
  const raw = connection ? JSON.stringify(connection) : null;
  if (Platform.OS === "web") {
    if (raw) globalThis.localStorage?.setItem(key, raw);
    else globalThis.localStorage?.removeItem(key);
    return;
  }
  if (raw) await SecureStore.setItemAsync(key, raw);
  else await SecureStore.deleteItemAsync(key);
}
