import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Check the key in use against the provider. */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await params;
  return handle(request, (app) => app.testKey(provider));
}
