import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { configureServer, emptyRows, fetchRows, type Rows } from "./api";
import { loadConnection, saveConnection, type Connection } from "./settings";
import { colors, font, radius, space } from "./theme";
import { telemetry } from "./telemetry";

type Store = {
  connection: Connection | null;
  ready: boolean;
  rows: Rows;
  loading: boolean;
  error: string | null;
  actionError: string | null;
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentConnection = useRef<Connection | null>(null);
  const connectionGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const changingConnection = useRef(false);
  const startupRead = useRef<Promise<void> | null>(null);

  const notify = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!currentConnection.current || changingConnection.current) return;
    const connectionAtStart = connectionGeneration.current;
    const requestAtStart = ++requestGeneration.current;
    const isCurrent = () => connectionAtStart === connectionGeneration.current &&
      requestAtStart === requestGeneration.current;
    if (!quiet) setLoading(true);
    try {
      const nextRows = await fetchRows();
      if (!isCurrent()) return;
      setRows(nextRows);
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      if (isCurrent()) {
        setError(message(cause, "Could not reach Fox Focus"));
        telemetry.emit({ kind: "error", name: "request_failed" }, "workspace");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    telemetry.emit({ kind: "count", name: "app_open" }, "app");
    startupRead.current = loadConnection().then(saved => {
      if (cancelled) return;
      configureServer(saved);
      currentConnection.current = saved;
      setConnection(saved);
      if (saved) {
        void load().finally(() => { if (!cancelled) setReady(true); });
      } else {
        setReady(true);
      }
    }).catch(cause => {
      if (!cancelled) {
        setError(message(cause, "Could not read saved connection"));
        setReady(true);
      }
    });
    return () => { cancelled = true; connectionGeneration.current++; };
  }, [load]);

  const inFlight = rows.actions.some(action => action.state === "queued" || action.state === "running") ||
    rows.jobs.some(job => job.state === "queued" || job.state === "working");

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
    setActionError(null);
    const connectionAtStart = connectionGeneration.current;
    try {
      if (changingConnection.current || !currentConnection.current) throw new Error("Connect to Fox Focus in Settings");
      await change();
      if (connectionAtStart !== connectionGeneration.current) return false;
      if (done) notify(done);
      await load(true);
      return true;
    } catch (cause) {
      if (connectionAtStart !== connectionGeneration.current) return false;
      setActionError(message(cause, "That didn't go through"));
      void load(true);
      return false;
    }
  }, [load, notify]);

  const connect = useCallback(async (next: Connection | null) => {
    if (startupRead.current) await startupRead.current;
    if (changingConnection.current) throw new Error("Connection change already in progress");
    changingConnection.current = true;
    connectionGeneration.current++;
    setLoading(false);
    let restoreRows = false;
    try {
      if (next) {
        // test before saving so a typo doesn't replace a working login
        configureServer(next);
        await fetchRows();
      }
      await saveConnection(next);
      configureServer(next);
      currentConnection.current = next;
      setConnection(next);
      setRows(emptyRows);
      setLoadedAt(null);
      setError(null);
      setActionError(null);
    } catch (cause) {
      configureServer(currentConnection.current);
      restoreRows = currentConnection.current !== null;
      throw cause;
    } finally {
      changingConnection.current = false;
      if (restoreRows) void load();
    }
    if (next) await load();
  }, [load]);

  const value = useMemo<Store>(() => ({
    connection, ready, rows, loading, error, actionError, loadedAt, refresh, run, connect, notify,
  }), [connection, ready, rows, loading, error, actionError, loadedAt, refresh, run, connect, notify]);

  return (
    <StoreContext.Provider value={value}>
      {children}
      {notice ? (
        <View pointerEvents="none" style={styles.notice} accessibilityLiveRegion="polite">
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
