import { randomUUID } from "node:crypto";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { assertPenetrationAuth } from "@/lib/auth/payloadAuth";
import { createRunState, runAgent } from "@/shared/lib/agentRuntime.js";
import { stopSandbox } from "@/shared/lib/pentestSandbox.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_MAX_STEPS = 12;
const HARD_MAX_STEPS = 40;

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * POST /api/developer/penetration/agent
 *
 * 9router-lith's built-in penetration testing agent. Root spawns worker agents
 * (recon, exploit, privesc) via the spawn_agent tool; all agents share a single
 * sandbox container and a single evidence ledger with zero external agent
 * interference — keeping blackbox testing reproducible and auditable.
 *
 * Loop mechanics:
 *   - Internal handleChat (our own router directly, no loopback HTTP)
 *   - Header x-9router-inject: off by default so measurements are not
 *     contaminated by global steering prompts. Body `inject` re-enables it for
 *     runs explicitly testing the injection stack.
 *   - Fresh session ID per run, matching A/B in the Developer tab: reusing a
 *     sticky connection ID would replay prior turns into subsequent runs.
 *
 * Response: SSE stream with events `{ type: start|text|tool_start|tool_end|agent_*|done|error }`.
 */
export async function POST(request) {
  if (!(await assertPenetrationAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureInitialized();

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = String(body?.target || "").trim();
  const scope = String(body?.scope || "").trim();
  const model = String(body?.model || "").trim();
  const instructions = String(body?.instructions || "").trim();
  const containerRuntime = String(body?.containerRuntime || "").trim() || undefined;
  const useInjection = body?.inject === true;
  const maxSteps = Math.min(
    Math.max(1, Number(body?.maxSteps) || DEFAULT_MAX_STEPS),
    HARD_MAX_STEPS
  );

  if (!target) return Response.json({ error: "Target is required" }, { status: 400 });
  if (!model) return Response.json({ error: "Model is required" }, { status: 400 });

  const keys = await getApiKeys().catch(() => []);
  const activeKey = Array.isArray(keys) ? keys.find((k) => k?.isActive && k.key) : null;
  if (!activeKey) {
    return Response.json(
      { error: "No active API key — create one in Endpoint settings first" },
      { status: 503 }
    );
  }

  const sessionId = `pent-${randomUUID()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client already disconnected */
        }
      };

      try {
        send({ type: "start", sessionId, model, maxSteps, inject: useInjection });

        const objective = [
          `Target: ${target}`,
          scope ? `Scope: ${scope}` : "Scope: only what is specified in target.",
          instructions ? `\nAdditional instructions:\n${instructions}` : "",
          "\nPerform blackbox security testing against the target. Use tools, do not guess.",
        ].join("\n");

        const state = createRunState();

        const result = await runAgent({
          role: "root",
          objective,
          scope,
          target,
          sessionId,
          runtime: containerRuntime,
          state,
          emit: send,
          maxSteps,
          callModel: (messages, tools) =>
            callModel(request, { model, messages, tools, activeKey, sessionId, useInjection }),
        });

        send({
          type: "done",
          finished: Boolean(result.report),
          failed: result.failed,
          reason: result.reason,
          report: result.report,
          notes: state.notes,
          failures: state.failures,
          children: state.children,
          evidenceCount: state.evidence.length,
        });
      } catch (error) {
        send({ type: "error", message: String(error?.message || error) });
      } finally {
        // Clean up the container so no sandbox process lingers after the run finishes.
        // Cleanup errors must not break stream closure.
        await stopSandbox(sessionId).catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Single model turn. Non-streaming so tool_calls arrive as a complete array —
 * parsing incremental tool_call deltas by index is brittle, and the UI displays
 * progress per tool rather than token-by-token.
 */
async function callModel(request, { model, messages, tools, activeKey, sessionId, useInjection }) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${activeKey.key}`);
  headers.set("accept", "application/json");
  headers.set("x-session-id", sessionId);
  if (!useInjection) headers.set("x-9router-inject", "off");

  const url = new URL("/api/v1/chat/completions", request.url);
  const forwarded = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    }),
  });

  const response = await handleChat(forwarded);
  if (!response || !response.ok) {
    const detail = await response?.text?.().catch(() => "");
    const message = `Model failed: ${response?.status || "unknown"} ${detail || ""}`.trim();
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  // Some executors still return SSE even when stream:false. Extract the
  // message object from the last data chunk containing choices.
  if (contentType.includes("text/event-stream")) {
    const message = lastMessageFromSse(raw);
    if (!message) throw new Error("Could not parse model response");
    return message;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model response is not valid JSON");
  }
  if (parsed?.error) {
    throw new Error(parsed.error?.message || String(parsed.error));
  }
  const message = parsed?.choices?.[0]?.message;
  if (!message) throw new Error("Model response did not contain a message");
  return message;
}

function lastMessageFromSse(raw) {
  let message = null;
  for (const line of String(raw).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      const candidate = chunk?.choices?.[0]?.message;
      if (candidate && (candidate.tool_calls?.length || candidate.content)) message = candidate;
    } catch {
      /* non-JSON chunk — ignore */
    }
  }
  return message;
}