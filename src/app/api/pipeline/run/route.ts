import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Run discovery, investigation and scoring now, in this process; answers with the cycle's report. */
export function POST(request: Request): Promise<Response> {
  return handle(request, (app) => app.runDiscovery());
}
