import { ApiError } from "@/core/web/api";
import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/**
 * Any API path without a route of its own. Answering here keeps the API's contract —
 * every response is guarded JSON — instead of falling through to the HTML 404 page.
 */
function notFound(request: Request): Promise<Response> {
  return handle(request, () => {
    throw new ApiError(404, "Not found");
  });
}

export { notFound as DELETE, notFound as GET, notFound as PATCH, notFound as POST, notFound as PUT };
