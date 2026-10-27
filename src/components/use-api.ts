"use client";

import { useCallback, useEffect, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useBusy } from "@/components/console-context";

export interface Loaded<T> {
  /** The latest successful response; kept on screen while a newer one loads. */
  data: T | null;
  /** Why the latest request failed, if it did. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** GET `path`, again whenever it changes or `reload` is called. */
export function useApi<T>(path: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; settled: string | null }>({
    data: null, error: null, settled: null,
  });
  const [attempt, setAttempt] = useState(0);
  const request = `${attempt}:${path}`;

  useEffect(() => {
    // A response that arrives after the filter moved on must not overwrite the newer one.
    let stale = false;
    api<T>("GET", path).then(
      (data) => {
        if (!stale) setState({ data, error: null, settled: request });
      },
      (error: unknown) => {
        if (!stale) setState((previous) => ({ data: previous.data, error: errorMessage(error), settled: request }));
      },
    );
    return () => {
      stale = true;
    };
  }, [path, request]);

  const loading = state.settled !== request;
  useBusy(loading);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data: state.data, error: loading ? null : state.error, loading, reload };
}
