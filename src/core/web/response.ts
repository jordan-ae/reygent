/** How every API response is sent. */

/**
 * A JSON response the browser must not cache or reinterpret.
 *
 * Listing text is untrusted, so the explicit content type plus `nosniff` matter: a
 * response can never be rendered as HTML, whatever it contains.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
