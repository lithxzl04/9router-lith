// ── Penetration agent runtime ─────────────────────────────────────────────────
//
// Reusable single-agent loop. Root spawns worker agents via spawn_agent; each
// agent has its own tool subset and system prompt, while sharing a single
// sandbox and evidence ledger so recon results can be referenced directly by
// exploit agents without manual copying.
//
// ponytail: only root may spawn sub-agents and total children are capped.
// Raise MAX_CHILDREN here if 3-tier hierarchy is needed later.

import { runAgentTool, toolsForRole, WORKER_ROLES } from "@/shared/lib/agentTools.js";

export const MAX_CHILDREN = 6;
export const WORKER_ROLES_EXPORT = WORKER_ROLES;

const ROLE_BRIEF = {
  root:
    "the root agent coordinating the security assessment. You break down the work, " +
    "spawn specialist worker agents with distinct objectives, and compile the final report.",
  recon:
    "the agent recon specialist. Your focus is mapping the attack surface: ports, services, versions, endpoints, and " +
    "candidate attack vectors. Do not attempt deep exploitation here.",
  exploit:
    "the agent exploit specialist. Your focus is proving a single vector with auditable evidence and " +
    "delivering its Proof of Concept. Evidence must be real and reproducible.",
  privesc:
    "the agent privesc specialist. Your focus is finding and proving privilege escalation paths. Claims of " +
    "root access are valid only when a command output proves execution as root.",
};

const ROOT_DELEGATION =
  "\n\nBefore spawning a sub-agent, decide: if you need an attack-surface map or initial leads, " +
  "use recon; if you have a concrete vector to prove, use exploit; if it involves elevating privileges, " +
  "use privesc. One sub-agent, one objective. After its report returns, decide the next step.";

const EVIDENCE_RULE =
  "\n\nNo finding without real evidence. If you cannot prove it, it is not a finding — " +
  "list it under unverified areas instead.";

/** System prompt for a single role. Kept concise: detailed rules live on the tools. */
export function systemPrompt(role, { target, scope } = {}) {
  const parts = [`You are ${ROLE_BRIEF[role] || ROLE_BRIEF.recon}.`];
  if (target) parts.push(`Target: ${target}`);
  if (scope) parts.push(`Scope: ${scope}`);
  if (role === "root") parts.push(ROOT_DELEGATION);
  parts.push(EVIDENCE_RULE);
  return parts.join("\n");
}

/** Shared state across all agents in a single run. */
export function createRunState() {
  return { evidence: [], failures: [], notes: [], children: [] };
}

/**
 * Run a single agent to completion.
 *
 * @param {object} o
 * @param {string} o.role              root | recon | exploit | privesc
 * @param {string} o.objective         Objective for this agent.
 * @param {(messages, tools) => Promise<{content: string, tool_calls?: object[]}>} o.callModel
 * @param {(event: object) => void} [o.emit]
 * @returns {Promise<{report: object|null, failed: boolean, reason: string}>}
 */
export async function runAgent({
  role = "root",
  objective,
  scope = "",
  target = "",
  sessionId,
  runtime,
  callModel,
  state,
  emit = () => {},
  maxSteps = 12,
  name = role,
}) {
  const ctx = {
    role,
    name,
    sessionId,
    runtime,
    notes: state.notes,
    evidence: state.evidence,
    failures: state.failures,
    finished: false,
    report: null,
    spawn: null,
  };

  // Spawning sub-agents is how root delegates work. Each child runs its own
  // loop and returns its report as the tool call result.
  if (role === "root") {
    ctx.spawn = async (rawArgs) => {
      const childRole = String(rawArgs.role || "recon");
      if (!WORKER_ROLES.includes(childRole)) {
        return `ERROR: unknown role "${childRole}". Valid options: ${WORKER_ROLES.join(", ")}.`;
      }
      if (state.children.length >= MAX_CHILDREN) {
        return `ERROR: limit of ${MAX_CHILDREN} sub-agents reached. Summarize with current results.`;
      }

      const childName = `${childRole}-${state.children.length + 1}`;
      const before = state.failures.length;
      const record = { name: childName, role: childRole, objective: rawArgs.objective };
      state.children.push(record);
      emit({ type: "agent_start", agent: childName, role: childRole, objective: rawArgs.objective });

      const result = await runAgent({
        role: childRole,
        objective: rawArgs.objective,
        scope: rawArgs.scope || scope,
        target,
        sessionId,
        runtime,
        callModel,
        state,
        emit,
        maxSteps: clampSteps(rawArgs.max_steps, 8, 20),
        name: childName,
      });

      record.failed = result.failed;
      record.reason = result.reason;

      // A child that stopped due to step exhaustion or model error never had
      // a chance to call report_failure itself. Record the failure in the
      // ledger so it is not silently lost.
      if (result.failed && state.failures.length === before) {
        state.failures.push({
          agent: childName,
          area: String(rawArgs.objective || childRole).slice(0, 120),
          reason: String(result.reason || "failed without reason"),
        });
      }

      emit({ type: "agent_end", agent: childName, role: childRole, failed: result.failed, reason: result.reason });
      return renderChildReport(childName, result);
    };
  }

  const tools = toolsForRole(role);
  const messages = [
    { role: "system", content: systemPrompt(role, { target, scope }) },
    { role: "user", content: objective || "Start the security assessment." },
  ];

  let nudged = false;

  for (let step = 1; step <= maxSteps; step++) {
    if (ctx.finished) break;
    emit({ type: "agent_step", agent: name, step, maxSteps });

    let message;
    try {
      message = await callModel(messages, tools);
    } catch (error) {
      const reason = textOf(error);
      emit({ type: "agent_error", agent: name, message: reason });
      return { report: ctx.report, failed: true, reason: reason };
    }

    if (message?.content) {
      emit({ type: "text", agent: name, content: message.content });
    }
    messages.push(message);

    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      // Model replied with text only and no tool call. Nudge once so the agent
      // does not stop mid-run without submitting its report.
      if (nudged) {
        return { report: ctx.report, failed: true, reason: "model stopped without finish" };
      }
      nudged = true;
      messages.push({
        role: "user",
        content: "Summarize your results now using the finish tool, or continue using the available tools.",
      });
      continue;
    }

    for (const call of calls) {
      const fnName = call?.function?.name;
      const rawArgs = call?.function?.arguments;
      emit({ type: "tool_start", agent: name, tool: fnName, args: rawArgs });

      let result;
      try {
        result = await runAgentTool(fnName, rawArgs, ctx);
      } catch (error) {
        result = `ERROR: tool failed — ${textOf(error)}`;
      }

      emit({
        type: "tool_end",
        agent: name,
        tool: fnName,
        output: String(result).slice(0, 2_000),
      });

      messages.push({
        role: "tool",
        tool_call_id: call?.id,
        content: String(result),
      });

      if (ctx.finished) break;
    }
  }

  if (!ctx.finished) {
    return { report: ctx.report, failed: true, reason: `step limit of ${maxSteps} exhausted` };
  }
  return { report: ctx.report, failed: false, reason: "finish" };
}

function renderChildReport(childName, result) {
  if (result.failed) {
    const failures = result.report?.notTested || [];
    return (
      `[${childName}] FAILED: ${result.reason}\n` +
      (failures.length ? `Not verified: ${failures.join("; ")}\n` : "") +
      "Do not treat this as a finding."
    );
  }
  const report = result.report || { summary: "(no report)", findings: [] };
  const lines = [`[${childName}] completed`, `Summary: ${report.summary || "(empty)"}`];
  for (const f of report.findings || []) {
    lines.push(`- ${f.title} (${f.severity}) evidence #${(f.evidenceIds || []).join(", #")}`);
  }
  if (report.notTested?.length) {
    lines.push(`Not verified: ${report.notTested.join("; ")}`);
  }
  return lines.join("\n");
}

function clampSteps(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.round(n), max);
}

function textOf(error) {
  if (!error) return "Unknown failure";
  return String(error.message || error).trim().slice(0, 500);
}