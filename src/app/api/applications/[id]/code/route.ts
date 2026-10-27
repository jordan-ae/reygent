import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Where an application held for an emailed code stands. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app) => app.codeHold(id));
}

/** { action: "ready" | "approve" | "skip", code?: string } on an application held for an emailed code. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app, { body }) => app.codeAction(id, body));
}
