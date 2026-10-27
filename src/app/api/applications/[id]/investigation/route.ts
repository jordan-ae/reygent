import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** The user's own call on a Tier 2 job: { decision: "qualify" | "disqualify" }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app, { body }) => app.resolveInvestigation(id, body));
}
