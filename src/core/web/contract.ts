/**
 * What every console endpoint is written against: the result it returns, the error it
 * throws, and the checks on what a request body may carry.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export type JsonObject = Record<string, unknown>;
export type Query = Record<string, string>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const ok = <T>(body: T): ApiResult<T> => ({ status: 200, body });

/** A job id as `jobId()` makes them. Anything else can never name a job, a file or a row. */
export const JOB_ID = /^[0-9a-f]{1,64}$/;

/** `data[key]` as trimmed text of at most `limit` characters; missing counts as empty. */
export function textField(data: JsonObject, key: string, limit: number, required = false): string {
  const raw = data[key] ?? "";
  if (typeof raw !== "string" || raw.length > limit) {
    throw new ApiError(400, `'${key}' must be text of at most ${limit} characters`);
  }
  const value = raw.trim();
  if (required && !value) throw new ApiError(400, `'${key}' is required`);
  return value;
}

/** `data[key]` as a non-negative amount, or null when it was left out. */
export function amountField(data: JsonObject, key: string): number | null {
  const value = data[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError(400, `'${key}' must be a non-negative number`);
  }
  return value;
}

/** The quarantined item ids a request names: 1 to 50 whole numbers. */
export function itemIds(body: JsonObject): number[] {
  const ids = body.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 50 ||
    !ids.every((id): id is number => typeof id === "number" && Number.isInteger(id))
  ) {
    throw new ApiError(400, "Request must carry a list of item 'ids'");
  }
  return ids;
}
