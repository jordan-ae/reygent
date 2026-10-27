import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Config, setup checklist, key status and component list. */
export function GET(request: Request): Promise<Response> {
  return handle(request, (app) => app.state());
}
