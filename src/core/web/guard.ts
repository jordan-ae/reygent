/**
 * The console's request guard.
 *
 * The console can rewrite the candidate's configuration and store API keys, so it only
 * answers same-origin requests addressed to its own localhost address. Checking `Host`
 * defeats DNS rebinding (a hostile page that resolves its own name to 127.0.0.1 still
 * sends its own name); the checks on writes defeat cross-site form posts and fetches.
 *
 * Nothing here imports Next, the database or the file system: `proxy.ts` loads this
 * module on every API request.
 */

import { jsonResponse } from "@/core/web/response";

export const DEFAULT_PORT = 8765;

/** The parts of a request the guard looks at. A header that was not sent is `null`. */
export interface RequestFacts {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
}

/** Why this is not a same-origin request to the console on `port`, or null if it is. */
export function checkRequest(request: RequestFacts, port: number): string | null {
  if (request.host !== `127.0.0.1:${port}` && request.host !== `localhost:${port}`) {
    return "This console only answers on its own localhost address.";
  }
  if (request.method.toUpperCase() === "GET") return null;
  if (
    request.origin !== null &&
    request.origin !== `http://127.0.0.1:${port}` &&
    request.origin !== `http://localhost:${port}`
  ) {
    return "Cross-origin requests are refused.";
  }
  if (request.secFetchSite !== null && request.secFetchSite !== "same-origin" && request.secFetchSite !== "none") {
    return "Cross-site requests are refused.";
  }
  // A cross-site form can only send three content types without a preflight; JSON is not one of them.
  if ((request.contentType ?? "").split(";")[0].trim() !== "application/json") {
    return "Requests must be JSON.";
  }
  return null;
}

export function requestFacts(request: Request): RequestFacts {
  return {
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    contentType: request.headers.get("content-type"),
  };
}

/**
 * The port this server is listening on.
 *
 * Next sets PORT to the port it actually bound (which, in dev, may differ from the one
 * asked for), so the allowed Host can never be chosen by the request itself.
 */
export function serverPort(): number {
  const port = Number(process.env.PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

/** The 403 to send instead of handling `request`, or null when it may proceed. */
export function refuse(request: Request, port: number = serverPort()): Response | null {
  const refusal = checkRequest(requestFacts(request), port);
  return refusal ? jsonResponse(403, { error: refusal }) : null;
}
