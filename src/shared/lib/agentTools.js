// ── Penetration agent tools ───────────────────────────────────────────────────
//
// Tools for the penetration testing agent. Shaped as OpenAI function-calling
// schemas so they work directly through 9router-lith's own /v1/chat/completions
// without an external agent SDK interfering with test results.
//
// Each role receives a distinct tool subset: root can spawn sub-agents via
// spawn_agent, while worker agents can report blocked areas via report_failure.
// All other tools are shared across roles.
//
// Remaining Strix tool ideas (proxy/Caido, agent_browser, agents_graph,
// threat_model) are noted in agentRuntime.js.

import { runInSandbox } from "@/shared/lib/pentestSandbox.js";
import { getStrixPayload, getStrixPayloads } from "open-sse/penetration/strixPayloads.js";

const STRIX_INDEX = getStrixPayloads()
  .map((p) => `${p.cat}/${p.name}`)
  .join(", ");

const MAX_FINDINGS = 100;
const MAX_FAILURES = 50;

const SHELL_DESCRIPTION =
  "Execute a shell command inside the Kali sandbox. Includes nmap, sqlmap, nuclei, subfinder, " +
  "naabu, ffuf, katana, curl, jq, python3, and standard Kali utilities. Output is returned verbatim " +
  "and recorded as numbered evidence. Workspace: /work.";

const LOAD_SKILL_DESCRIPTION =
  "Load the complete testing methodology for a vulnerability class before testing that area. " +
  "Call this when you need a structured procedure rather than guessing.";

const NOTES_DESCRIPTION = "Record intermediate observations, tested endpoints, or discovered credentials.";

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Concise vulnerability title." },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "info"],
      description: "Honest severity rating. Inflating severity undermines the entire assessment.",
    },
    evidence_ids: {
      type: "array",
      items: { type: "integer" },
      description:
        "Evidence numbers from shell tool outputs that prove this finding. Required and " +
        "must reference existing evidence IDs — unsubstantiated claims are rejected.",
    },
    evidence_quote: {
      type: "string",
      description:
        "Exact substring from one of the cited evidence outputs. Must match the shell output " +
        "verbatim, not a paraphrase.",
    },
    cvss: {
      type: "string",
      description: "Full CVSS v3.1 vector, e.g. \"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H\". Leave empty if not calculated.",
    },
    cve: {
      type: "string",
      description: "Associated CVE identifier if confirmed. Leave empty if none.",
    },
    impact: { type: "string", description: "What an attacker can concretely achieve through this finding." },
    remediation: { type: "string", description: "Actionable remediation steps." },
  },
  required: ["title", "severity", "evidence_ids", "evidence_quote"],
};

const FINISH_DESCRIPTION =
  "Mark this agent's task as complete and submit its report to the caller. Call once at the end.";

function shellTool() {
  return {
    type: "function",
    function: {
      name: "shell",
      description: SHELL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command (compound commands and pipelines allowed)." },
          timeout_s: {
            type: "integer",
            description: "Timeout in seconds. Default 120, max 600. Increase for large scans.",
          },
        },
        required: ["command"],
      },
    },
  };
}

function loadSkillTool() {
  return {
    type: "function",
    function: {
      name: "load_skill",
      description: LOAD_SKILL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `Skill name, e.g. "sql_injection", "cvss_scoring". Available: ${STRIX_INDEX}`,
          },
        },
        required: ["name"],
      },
    },
  };
}

function notesTool() {
  return {
    type: "function",
    function: {
      name: "notes",
      description: NOTES_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Note content." },
        },
        required: ["text"],
      },
    },
  };
}

function finishTool({ hasUntested }) {
  const properties = {
    summary: { type: "string", description: "Executive summary." },
    findings: {
      type: "array",
      description: "Only findings backed by shell output evidence from this run.",
      items: FINDING_SCHEMA,
    },
  };
  const required = ["summary"];
  if (hasUntested) {
    properties.not_tested = {
      type: "array",
      items: { type: "string" },
      description:
        "Areas that could not be verified, with reasons. Keeps the report honest about assessment coverage.",
    };
    required.push("not_tested");
  }
  return {
    type: "function",
    function: { name: "finish", description: FINISH_DESCRIPTION, parameters: { type: "object", properties, required } },
  };
}

function reportFailureTool() {
  return {
    type: "function",
    function: {
      name: "report_failure",
      description:
        "Report an area that could not be tested. Recorded in the root report as a known coverage gap, " +
        "not a finding. Call as soon as you confirm you cannot proceed in that area.",
      parameters: {
        type: "object",
        properties: {
          area: { type: "string", description: "Area or target that could not be tested." },
          reason: { type: "string", description: "Actual reason, e.g. WAF blocking or host unreachable." },
          attempts: { type: "string", description: "What was attempted before giving up." },
        },
        required: ["area", "reason"],
      },
    },
  };
}

function spawnAgentTool(roles) {
  return {
    type: "function",
    function: {
      name: "spawn_agent",
      description:
        "Spawn a new worker agent with a specialized role, run it to completion, and receive its report. " +
        "All agents share the same sandbox, so files and outputs from other agents remain accessible.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: Object.keys(roles),
            description: "Specialized role for the spawned worker agent.",
          },
          objective: {
            type: "string",
            description: "Single specific, measurable objective for this worker agent.",
          },
          scope: { type: "string", description: "Target or path this worker agent is allowed to explore." },
          max_steps: {
            type: "integer",
            description: "Step limit for this worker agent. Default 8, max 20.",
          },
        },
        required: ["role", "objective"],
      },
    },
  };
}

/**
 * Tools for a given role. Root gets spawn_agent; worker agents get
 * report_failure. Only root requires not_tested in finish since root compiles
 * the final report.
 */
export function toolsForRole(role) {
  const tools = [shellTool(), loadSkillTool(), notesTool()];
  if (role === "root") {
    tools.push(spawnAgentTool(WORKER_ROLES));
  } else {
    tools.push(reportFailureTool());
  }
  tools.push(finishTool({ hasUntested: role === "root" }));
  return tools;
}

export const WORKER_ROLES = ["recon", "exploit", "privesc"];

export const AGENT_TOOLS = toolsForRole("root");

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.function.name);

const MAX_NOTES_CHARS = 40_000;

/**
 * Execute a single tool call. Always returns a string — the model only sees
 * text, so errors are returned as plain messages rather than thrown objects.
 */
export async function runAgentTool(name, rawArgs, ctx) {
  const args = safeParse(rawArgs);

  switch (name) {
    case "shell": {
      const command = String(args.command || "").trim();
      if (!command) return "ERROR: `command` parameter is empty.";
      const timeoutMs = clampTimeout(args.timeout_s);
      const result = await runInSandbox(ctx.sessionId, command, {
        timeout: timeoutMs,
        runtime: ctx.runtime,
      });
      const head = result.ok
        ? `$ ${command}\n${result.output || "(empty — command succeeded with no output)"}`
        : `$ ${command}\nEXIT ${result.exitCode ?? "?"}\n${result.output}`;

      // Numbered evidence: prevents fabricated claims because every finding
      // must cite an evidence ID recorded here.
      const id = (ctx.evidence?.length || 0) + 1;
      if (ctx.evidence) {
        ctx.evidence.push({
          id,
          command,
          output: String(result.output || ""),
          exitCode: result.exitCode ?? null,
          ok: Boolean(result.ok),
          ms: result.ms ?? null,
        });
      }
      return `Evidence #${id}\n${head}`;
    }

    case "load_skill": {
      const key = normalizeSkillKey(args.name);
      const payload = key ? getStrixPayload(key) : null;
      if (!payload) {
        return `ERROR: unknown skill "${args.name}".\nAvailable: ${STRIX_INDEX}`;
      }
      return `# ${payload.name} (${payload.cat})\n\n${String(payload.text || "").slice(0, 40_000)}`;
    }

    case "notes": {
      const text = String(args.text || "").trim();
      if (!text) return "ERROR: `text` parameter is empty.";
      ctx.notes.push(text);
      return `Recorded (${ctx.notes.length} notes, ${ctx.notes.join("\n").length} total chars).`;
    }

    case "spawn_agent": {
      if (ctx.role !== "root" || typeof ctx.spawn !== "function") {
        return "ERROR: only the root agent can spawn sub-agents.";
      }
      return ctx.spawn(args);
    }

    case "report_failure": {
      const area = String(args.area || "").trim();
      const reason = String(args.reason || "").trim();
      if (!area || !reason) return "ERROR: `area` and `reason` parameters are required.";
      ctx.failures.push({
        area,
        reason,
        attempts: String(args.attempts || "").trim(),
      });
      return "Failure reported to root agent. Proceed to another area.";
    }

    case "finish": {
      const verdict = auditFindings(args.findings, ctx.evidence);
      if (!verdict.ok) return verdict.message;

      ctx.finished = true;
      ctx.report = {
        summary: String(args.summary || ""),
        findings: verdict.findings,
        notTested: Array.isArray(args.not_tested)
          ? args.not_tested.map((t) => String(t)).slice(0, MAX_FAILURES)
          : [],
      };
      return "Results accepted. Call finish only once, then stop calling tools.";
    }

    default:
      return `ERROR: unknown tool "${name}".`;
  }
}

/**
 * Anti-false-positive gate. Every finding must cite evidence that actually
 * exists in this run and quote it verbatim, preventing the model from
 * hallucinating evidence. Unauditable claims are rejected.
 */
export function auditFindings(rawFindings, evidence) {
  const list = Array.isArray(rawFindings) ? rawFindings.slice(0, MAX_FINDINGS) : [];
  if (!list.length) return { ok: true, findings: [] };

  const byId = new Map((evidence || []).map((e) => [e.id, e]));
  const accepted = [];

  for (const [index, raw] of list.entries()) {
    const title = String(raw?.title || "").trim();
    const ids = Array.isArray(raw?.evidence_ids)
      ? raw.evidence_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : [];

    if (!title) {
      return reject(index, "title is empty", evidence);
    }
    if (!ids.length) {
      return reject(index, "missing evidence_ids", evidence);
    }

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      return reject(index, `evidence_ids ${missing.join(", ")} do not exist in this run`, evidence);
    }

    const quote = String(raw?.evidence_quote || "");
    if (!quote) return reject(index, "missing evidence_quote", evidence);

    const cited = ids.map((id) => byId.get(id));
    const haystack = normalizeForQuote(cited.map((e) => e.output).join("\n"));
    if (!haystack.includes(normalizeForQuote(quote))) {
      return reject(
        index,
        `evidence_quote does not match exact output of evidence ${ids.join(", ")}`,
        evidence
      );
    }

    accepted.push({
      title,
      severity: String(raw?.severity || "info"),
      evidenceIds: ids,
      evidenceQuote: quote,
      cvss: String(raw?.cvss || "").trim(),
      cve: String(raw?.cve || "").trim(),
      impact: String(raw?.impact || "").trim(),
      remediation: String(raw?.remediation || "").trim(),
    });
  }

  return { ok: true, findings: accepted };
}

function reject(index, reason, evidence) {
  const valid = (evidence || []).map((e) => e.id);
  return {
    ok: false,
    message:
      `ERROR: finding #${index + 1} rejected — ${reason}.\n` +
      `Only claims backed by real evidence are accepted. Available evidence: ` +
      `${valid.length ? valid.join(", ") : "(none yet — run shell first)"}.`,
  };
}

// Whitespace/indentation differences should not invalidate a quote: models
// frequently copy output with normalized spacing.
function normalizeForQuote(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function safeParse(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clampTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 120_000;
  return Math.min(Math.round(seconds * 1000), 600_000);
}

/**
 * Accept "sql_injection", "sql-injection", "vulnerabilities/sql_injection",
 * or the full ID "strix:vulnerabilities:sql_injection". Models guess different
 * formats; normalize so valid skill names never fail lookup.
 */
function normalizeSkillKey(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (raw.startsWith("strix:")) return getStrixPayload(raw) ? raw : null;

  const slug = raw.toLowerCase().replace(/[\s-]+/g, "_");

  // Format "vulnerabilities/sql_injection" or "vulnerabilities/sql-injection":
  // models often use category/name because that matches the UI display.
  if (raw.includes("/")) {
    const [cat, ...rest] = raw.split("/");
    const catSlug = cat.trim().toLowerCase();
    const nameSlug = rest.join("/").trim().toLowerCase().replace(/[\s-]+/g, "_");
    for (const meta of getStrixPayloads()) {
      if (String(meta.cat).toLowerCase() === catSlug && meta.name === nameSlug) return meta.id;
    }
  }

  for (const meta of getStrixPayloads()) {
    if (meta.name === slug) return meta.id;
    if (String(meta.name).toLowerCase().replace(/[_-]+/g, "_") === slug.replace(/[_-]+/g, "_")) {
      return meta.id;
    }
  }
  return null;
}