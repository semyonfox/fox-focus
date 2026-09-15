import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { configureServer, emptyRows, fetchRows, type Rows } from "./api";
import { loadConnection, saveConnection, type Connection } from "./settings";
import { colors, font, radius, space } from "./theme";

type Store = {
  connection: Connection | null;
  ready: boolean;
  rows: Rows;
  loading: boolean;
  error: string | null;
  loadedAt: string | null;
  refresh: () => Promise<void>;
  // runs one server change, reports it, then reloads rows
  run: (change: () => Promise<unknown>, done?: string) => Promise<boolean>;
  connect: (connection: Connection | null) => Promise<void>;
  notify: (text: string) => void;
};

const StoreContext = createContext<Store | null>(null);

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

// same cadence as the web app: quick while Google or Gmail work is in flight, otherwise every 15 seconds
const quickPollMs = 1_000;
const pollMs = 15_000;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Rows>(emptyRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setRows(await fetchRows());
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(message(cause, "Could not reach Fox Focus"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadConnection().then(async saved => {
      if (cancelled) return;
      configureServer(saved);
      setConnection(saved);
      if (saved) await load();
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [load]);

  const inFlight = rows.actions.some(action => action.state === "queued" || action.state === "running");

  useEffect(() => {
    if (!connection) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        if (AppState.currentState === "active") void load(true).finally(schedule);
        else schedule();
      }, inFlight ? quickPollMs : pollMs);
    };
    schedule();
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void load(true); });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [connection, inFlight, load]);

  const refresh = useCallback(async () => {
    if (connection) await load();
  }, [connection, load]);

  const run = useCallback(async (change: () => Promise<unknown>, done?: string) => {
    try {
      await change();
      if (done) notify(done);
      await load(true);
      return true;
    } catch (cause) {
      notify(message(cause, "That didn't go through"));
      void load(true);
      return false;
    }
  }, [load, notify]);

  const connect = useCallback(async (next: Connection | null) => {
    if (next) {
      // test before saving so a typo doesn't replace a working login
      configureServer(next);
      try {
        await fetchRows();
      } catch (cause) {
        configureServer(connection);
        throw cause;
      }
    } else {
      configureServer(null);
      setRows(emptyRows);
      setLoadedAt(null);
      setError(null);
    }
    await saveConnection(next);
    setConnection(next);
    if (next) await load();
  }, [connection, load]);

  const value = useMemo<Store>(() => ({
    connection, ready, rows, loading, error, loadedAt, refresh, run, connect, notify,
  }), [connection, ready, rows, loading, error, loadedAt, refresh, run, connect, notify]);

  return (
    <StoreContext.Provider value={value}>
      {children}
      {notice ? (
        <View pointerEvents="none" style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
    </StoreContext.Provider>
  );
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore needs a StoreProvider");
  return store;
}

const styles = StyleSheet.create({
  notice: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    bottom: 96,
    backgroundColor: colors.panelMuted,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  noticeText: { color: colors.strong, fontSize: font.small },
});
