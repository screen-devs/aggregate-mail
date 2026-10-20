import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "../../shared/workspace";
import type { Api } from "../api";

const empty: Workspace = { commitments: [], projects: [], decisions: [], coverage: [], proposals: [] };

// App owns this snapshot across mail, Today and Calendar. No private disk cache.
export function useWorkspace(api: Api, enabled = true) {
  const [workspace, setWorkspace] = useState(empty);
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const live = useRef(false);
  const lock = useRef(false);
  const unsafe = useRef(true);
  const review = useRef(false);
  const read = useRef<Promise<boolean> | null>(null);
  const refresh = useCallback((afterWrite = false): Promise<boolean> => {
    if (lock.current && !afterWrite) return Promise.resolve(false);
    if (read.current) return read.current;
    setRefreshing(true);
    read.current = (async () => {
      try {
        const value = await api<Workspace>("/workspace");
        if (![value.commitments, value.projects, value.decisions, value.coverage, value.proposals].every(Array.isArray)) throw new Error();
        if (!live.current) return false;
        setWorkspace(value); setLoaded(true); setStale(false); setError(""); unsafe.current = false;
        return true;
      } catch {
        if (live.current) {
          unsafe.current = true; setStale(true);
          setError("Workspace could not be loaded. Cached work may be stale. Refresh before editing.");
        }
        return false;
      } finally {
        read.current = null;
        if (live.current) setRefreshing(false);
      }
    })();
    return read.current;
  }, [api]);
  const refreshFresh = useCallback(async () => {
    // A read already in flight can predate the write being reconciled.
    if (read.current) await read.current;
    return refresh();
  }, [refresh]);
  useEffect(() => {
    live.current = true;
    if (enabled) void refresh();
    return () => { live.current = false; };
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      setNow(Date.now());
      if (!lock.current) void refresh();
    };
    const timer = window.setInterval(tick, 60000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [enabled, refresh]);
  const mutate = async (task: () => Promise<unknown>) => {
    if (lock.current || read.current || unsafe.current || review.current) return false;
    lock.current = true; setPending(true); setError("");
    try {
      await task();
      const ok = await refresh(true);
      if (!ok && live.current) setError("Change was saved, but workspace refresh failed. Your input remains here. Refresh the workspace to inspect the saved result before making another change.");
      return ok;
    } catch {
      unsafe.current = true; review.current = true;
      if (live.current) {
        setStale(true); setReviewRequired(true);
        setError("Change was not confirmed. Your input is still here. Refresh and review saved work before retrying; the change may already have been saved.");
      }
      return false;
    } finally {
      lock.current = false;
      if (live.current) setPending(false);
    }
  };
  const acknowledgeReview = () => {
    if (unsafe.current || read.current || lock.current) return;
    review.current = false; setReviewRequired(false);
  };
  return { api, workspace, loaded, stale, refreshing, pending, reviewRequired, error, now, refresh, refreshFresh, mutate, acknowledgeReview,
    blocked: !loaded || stale || pending || reviewRequired };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;
