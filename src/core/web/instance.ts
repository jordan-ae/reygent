/** The one WebApp this server process uses, and the wrappers every route handler goes through. */

import { type ApiResult, WebApp } from "@/core/web/api";
import { serverPort } from "@/core/web/guard";
import { type ApiInput, serve, serveFile } from "@/core/web/http";

const INSTANCE = Symbol.for("reygent.web.app");
type Holder = { [INSTANCE]?: WebApp };

/**
 * Where the console looks for confirmation screenshots instead of ~/.reygent/evidence.
 * Like $REYGENT_DB and $REYGENT_CONFIG, it lets a console run entirely on scratch data.
 */
export const EVIDENCE_ENV_VAR = "REYGENT_EVIDENCE_DIR";

/**
 * The process-wide console, opened on first use.
 *
 * It lives on `globalThis` because the dev server re-evaluates modules on every edit;
 * a module-level variable would open the database again each time. Opening lazily also
 * keeps `next build`, which imports every route, from touching the database at all.
 */
export function getWebApp(): WebApp {
  const holder = globalThis as Holder;
  return (holder[INSTANCE] ??= new WebApp({ evidenceDir: process.env[EVIDENCE_ENV_VAR] || undefined }));
}

/** Run one guarded API request against the console. */
export function handle(
  request: Request,
  work: (app: WebApp, input: ApiInput) => ApiResult | Promise<ApiResult>,
): Promise<Response> {
  return serve(request, serverPort(), (input) => work(getWebApp(), input));
}

/** Answer one guarded request with a PNG the console vouches for. */
export function handleImage(request: Request, locate: (app: WebApp) => string): Promise<Response> {
  return serveFile(request, serverPort(), "image/png", () => locate(getWebApp()));
}
