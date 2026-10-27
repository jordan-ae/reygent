/** The browser's side of the console API. */

type Method = "GET" | "POST" | "PUT" | "DELETE";

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Call the console API. Rejects with a message fit to show the user. */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, cache: "no-store" };
  if (method !== "GET") {
    // The server refuses any write that is not JSON, which is what blocks cross-site form posts.
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("Cannot reach the Reygent console. Is `npm run web` still running?");
  }
  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    // A non-JSON error body: fall through to the status.
  }
  if (!response.ok) {
    const reported = (payload as { error?: unknown } | null)?.error;
    throw new Error(typeof reported === "string" && reported ? reported : `Request failed (${response.status})`);
  }
  return payload as T;
}
