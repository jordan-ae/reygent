import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app) => app.application(id));
}
