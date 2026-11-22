// P0 GOLDEN: lock buildUrl + buildHeaders for every provider on the baseline code.
// Generates baseline snapshot on first run → must match identically after refactoring.
// Mocking proxyFetch + uuid-heavy executors is not needed here since only pure buildUrl/buildHeaders are called.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Deterministic sample credentials — do NOT use Date.now/random.
const API_KEY_CRED = { apiKey: "«reda...…»", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "«reda...…»",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Providers with dedicated executors (buildUrl/buildHeaders not in DefaultExecutor) → skipped in this golden test.
// They are locked separately in specialized provider unit tests.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
]);

// Per-process / per-request values: kimi's random device name, minimax's session UUID.
const VOLATILE_HEADERS = new Set(["x-msh-device-name", "x-mavis-session-id"]);

// Request-scoped UUIDs (X-Request-ID, X-Conversation-ID, …) are minted fresh on
// every buildHeaders() call, so a raw snapshot can never stay stable — a golden
// test that fails on every run teaches nothing. Normalize the UUID shape instead
// of the header name, so new UUID-bearing headers are covered automatically.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Sanitize headers: redact tokens and dynamic timestamp fields (kimi X-Msh-Device-Id) for stable snapshots.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (VOLATILE_HEADERS.has(k.toLowerCase())) { out[k] = "<VOLATILE>"; continue; }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
          .replace(UUID_RE, "<UUID>")
          // cline sends process.version — different Node runtime, different
          // snapshot, so pin the shape instead of the installed version.
          .replace(/^v\d+\.\d+\.\d+(?:[-+].*)?$/, "v<NODE>")
      : v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
