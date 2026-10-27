/** Minimal JSON-over-HTTPS transport shared by the LLM clients. */

import { wellFormed } from "@/core/text";

/** (url, payload, headers, timeoutSeconds) -> decoded JSON response */
export type Transport = (
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutSeconds: number,
) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Rate-limit and overload responses: the request was rejected, so it was not billed.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/** The provider answered with an error status (so the request was not billed). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST `payload` as JSON and return the decoded response.
 *
 * Retries with exponential backoff on rate-limit/overload statuses only. Timeouts and
 * connection errors are thrown immediately: the provider may already have processed
 * (and billed) the request, so repeating it could double the spend.
 */
export async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutSeconds: number,
  retries = 2,
  backoffSeconds = 0.5,
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "reygent/0.2", ...headers },
      // Text cut at a fixed length anywhere upstream can end in half an emoji, and one
      // such character makes a provider refuse the whole request.
      body: JSON.stringify(payload, (_key, value: unknown) => (typeof value === "string" ? wellFormed(value) : value)),
      // AbortSignal.timeout throws on a fractional delay, and 16.1 * 1000 is 16100.000000000002.
      signal: AbortSignal.timeout(Math.round(timeoutSeconds * 1000)),
    });
    if (response.ok) return response.json();
    const body = (await response.text()).slice(0, 500);
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await sleep(backoffSeconds * 2 ** attempt * 1000);
      continue;
    }
    throw new HttpError(response.status, body);
  }
}
