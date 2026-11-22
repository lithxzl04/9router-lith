import { cookies, headers } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;

async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

/**
 * Defense-in-depth auth gate for developer payload routes.
 * Independent of the global dashboardGuard middleware: requires either a
 * valid dashboard JWT cookie or the local CLI token. Returns true when
 * authenticated; callers return 401 when false.
 */
export async function assertPayloadAuth(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (await verifyDashboardAuthToken(token)) return true;

  const cliToken = (await headers()).get(CLI_TOKEN_HEADER);
  if (cliToken && cliToken === (await getCliToken())) return true;

  return false;
}

/**
 * Same-origin check for browser requests.
 *
 * Browsers cannot hold the machine CLI token, so a pure AND gate would make
 * the penetration tab unreachable from the UI. Cross-site requests are still
 * rejected because browsers always send the Origin header on cross-site POSTs —
 * closing the CSRF vector while allowing authenticated dashboard sessions to
 * run tests.
 */
function isSameOriginBrowserRequest(request) {
  if (!request) return false;
  const headers = request.headers;
  if (!headers?.get) return false;
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin) {
    try {
      return host ? new URL(origin).host === host : false;
    } catch {
      return false;
    }
  }
  // Without Origin: not a cross-site browser request. Local scripts (curl, CLI)
  // also omit Origin, but they authenticate via the CLI token above.
  const site = headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

/**
 * Auth gate for skill execution routes (penetration tab, design §5.3).
 *
 * Accepts: machine CLI token, or a valid dashboard session originating from the
 * same Origin as the host. Skill execution is an active execution surface rather
 * than a read-only view, so this gate is stricter than assertPayloadAuth's OR-gate.
 */
export async function assertPenetrationAuth(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const jwtOk = await verifyDashboardAuthToken(token);
  const cliHeader = (await headers()).get(CLI_TOKEN_HEADER);
  if (cliHeader && cliHeader === (await getCliToken())) return true;
  return jwtOk && isSameOriginBrowserRequest(request);
}
