import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(request, (app) => app.costs());
}
