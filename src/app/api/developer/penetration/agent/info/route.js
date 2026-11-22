import { assertPenetrationAuth } from "@/lib/auth/payloadAuth";
import { sandboxInfo } from "@/shared/lib/pentestSandbox.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/developer/penetration/agent/info
 *
 * Reports which container runtimes are available and whether the sandbox image
 * is ready, so the GUI can populate the selector and warn early if the image
 * needs to be built first.
 */
export async function GET(request) {
  if (!(await assertPenetrationAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(await sandboxInfo());
}