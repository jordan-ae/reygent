/**
 * The HTTP edge of the console API, written against the standard Request and Response
 * so it can be exercised without a server: guard, body parsing, and the mapping from a
 * `WebApp` result or error to a response.
 */

import fs from "node:fs/promises";

import { ApiError, type ApiResult, type JsonObject, type Query, isJsonObject } from "@/core/web/contract";
import { refuse } from "@/core/web/guard";
import { jsonResponse } from "@/core/web/response";

export const MAX_BODY_BYTES = 1_000_000;

export interface ApiInput {
  /** Query parameters of a GET; the last value wins when one is repeated. */
  query: Query;
  /** The JSON object sent with a write; empty for a GET or an empty body. */
  body: JsonObject;
}

/** The request body as a JSON object. Throws ApiError 400 or 413. */
export async function readJsonBody(request: Request): Promise<JsonObject> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) throw new ApiError(400, "Invalid Content-Length");
    // Refused on the header alone, before any of the body is read into memory.
    if (Number(declared) > MAX_BODY_BYTES) throw new ApiError(413, "Request is too large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    // A chunked body declares no length, so it is also counted as it arrives.
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request is too large");
      }
      chunks.push(value);
    }
  }
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, "Request body is not valid JSON");
  }
  if (!isJsonObject(body)) throw new ApiError(400, "Request body must be a JSON object");
  return body;
}

/** What a failed request is answered with. Only an ApiError's own message ever reaches the page. */
function failure(error: unknown): Response {
  if (error instanceof ApiError) return jsonResponse(error.status, { error: error.message });
  // Last-resort boundary: report in the terminal, never leak internals to the page.
  console.error(error);
  return jsonResponse(500, { error: "Internal error — see the terminal running the console." });
}

/**
 * Answer one API request: refuse it unless it is a same-origin request to this console
 * on `port`, parse its input, run `work`, and report the outcome as JSON.
 */
export async function serve(
  request: Request,
  port: number,
  work: (input: ApiInput) => ApiResult | Promise<ApiResult>,
): Promise<Response> {
  const refusal = refuse(request, port);
  if (refusal) return refusal;
  try {
    const input: ApiInput =
      request.method === "GET"
        ? { query: Object.fromEntries(new URL(request.url).searchParams), body: {} }
        : { query: {}, body: await readJsonBody(request) };
    const result = await work(input);
    return jsonResponse(result.status, result.body);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Answer a guarded request with a file that `locate` vouches for. `locate` decides which
 * file, if any; this only sends it, labelled so the browser cannot treat it as anything else.
 */
export async function serveFile(
  request: Request,
  port: number,
  contentType: string,
  locate: () => string | Promise<string>,
): Promise<Response> {
  const refusal = refuse(request, port);
  if (refusal) return refusal;
  try {
    const content = await fs.readFile(await locate());
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(content.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
