import { describe, it, expect } from "vitest";
import { auditFindings, toolsForRole, runAgentTool } from "@/shared/lib/agentTools.js";
import { createRunState, runAgent, systemPrompt } from "@/shared/lib/agentRuntime.js";

// Fabricated evidence is the most damaging failure mode in security reports,
// so every branch of this gate has its own unit test.
const EVIDENCE = [
  { id: 1, command: "curl -i http://t/", output: "HTTP/1.1 200 OK\nServer: nginx/1.18.0", ok: true },
  { id: 2, command: "nmap -sV t", output: "22/tcp open ssh OpenSSH 8.2p1", ok: true },
];

describe("auditFindings — anti-hallucination gate", () => {
  it("accepts findings whose evidence exists and whose quote matches", () => {
    const result = auditFindings(
      [{ title: "Outdated nginx version", severity: "low", evidence_ids: [1], evidence_quote: "nginx/1.18.0" }],
      EVIDENCE
    );
    expect(result.ok).toBe(true);
    expect(result.findings[0].evidenceIds).toEqual([1]);
  });

  it("rejects findings without evidence_ids", () => {
    const result = auditFindings(
      [{ title: "Suspected SQLi", severity: "high", evidence_quote: "anything" }],
      EVIDENCE
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("evidence_ids");
  });

  it("rejects findings citing non-existent evidence", () => {
    const result = auditFindings(
      [{ title: "Hallucinated", severity: "high", evidence_ids: [99], evidence_quote: "root:x:0:0" }],
      EVIDENCE
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("do not exist in this run");
  });

  it("rejects quotes absent from the actual evidence output", () => {
    const result = auditFindings(
      [{ title: "Fake", severity: "critical", evidence_ids: [1], evidence_quote: "database_dump.sql" }],
      EVIDENCE
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match exact output");
  });

  it("still accepts quotes that differ only by whitespace/indentation", () => {
    const result = auditFindings(
      [{ title: "Old SSH", severity: "info", evidence_ids: [2], evidence_quote: "OpenSSH 8.2p1" }],
      EVIDENCE
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the entire batch if any single finding is unsubstantiated", () => {
    const result = auditFindings(
      [
        { title: "Real", severity: "low", evidence_ids: [1], evidence_quote: "nginx" },
        { title: "Fake", severity: "critical", evidence_ids: [7], evidence_quote: "anything" },
      ],
      EVIDENCE
    );
    expect(result.ok).toBe(false);
  });

  it("passes with zero findings", () => {
    expect(auditFindings([], EVIDENCE).ok).toBe(true);
  });
});

describe("toolsForRole", () => {
  const names = (role) => toolsForRole(role).map((t) => t.function.name);

  it("root can spawn sub-agents, worker agents cannot", () => {
    expect(names("root")).toContain("spawn_agent");
    for (const role of ["recon", "exploit", "privesc"]) {
      expect(names(role)).not.toContain("spawn_agent");
    }
  });

  it("worker agents can report failures", () => {
    for (const role of ["recon", "exploit", "privesc"]) {
      expect(names(role)).toContain("report_failure");
    }
  });

  it("root must provide not_tested, worker agents do not", () => {
    const rootFinish = toolsForRole("root").find((t) => t.function.name === "finish");
    const workerFinish = toolsForRole("recon").find((t) => t.function.name === "finish");
    expect(rootFinish.function.parameters.required).toContain("not_tested");
    expect(workerFinish.function.parameters.required).not.toContain("not_tested");
  });

  it("all roles share the core tool set", () => {
    for (const role of ["root", "recon", "exploit", "privesc"]) {
      for (const tool of ["shell", "load_skill", "notes", "finish"]) {
        expect(names(role)).toContain(tool);
      }
    }
  });

  it("findings require evidence in the JSON schema itself, not only in descriptions", () => {
    const finish = toolsForRole("root").find((t) => t.function.name === "finish");
    const item = finish.function.parameters.properties.findings.items;
    expect(item.required).toEqual(["title", "severity", "evidence_ids", "evidence_quote"]);
  });
});

function ctxWith(overrides = {}) {
  return {
    role: "root",
    name: "root",
    sessionId: "test-session",
    notes: [],
    evidence: [],
    failures: [],
    finished: false,
    report: null,
    ...overrides,
  };
}

describe("runAgentTool — finish and report_failure", () => {
  it("rejects finish and keeps run open when finding lacks evidence", async () => {
    const ctx = ctxWith({ evidence: [...EVIDENCE] });
    const out = await runAgentTool("finish", { summary: "s", findings: [{ title: "x", severity: "high" }] }, ctx);
    expect(out).toContain("rejected");
    expect(ctx.finished).toBe(false);
  });

  it("accepts finish when evidence is valid", async () => {
    const ctx = ctxWith({ evidence: [...EVIDENCE] });
    const out = await runAgentTool(
      "finish",
      { summary: "s", findings: [{ title: "old nginx", severity: "low", evidence_ids: [1], evidence_quote: "nginx/1.18.0" }], not_tested: [] },
      ctx
    );
    expect(out).not.toContain("rejected");
    expect(ctx.finished).toBe(true);
    expect(ctx.report.findings).toHaveLength(1);
  });

  it("records report_failure into the failure ledger", async () => {
    const ctx = ctxWith();
    await runAgentTool("report_failure", { area: "/admin", reason: "WAF blocked", attempts: "curl, sqlmap" }, ctx);
    expect(ctx.failures).toHaveLength(1);
    expect(ctx.failures[0].area).toBe("/admin");
  });

  it("report_failure rejects empty area", async () => {
    const ctx = ctxWith();
    const out = await runAgentTool("report_failure", { area: "", reason: "" }, ctx);
    expect(out).toContain("ERROR");
    expect(ctx.failures).toHaveLength(0);
  });

  it("worker agent cannot call spawn_agent even if ctx has spawn", async () => {
    const ctx = ctxWith({ role: "recon", spawn: async () => "should not be called" });
    const out = await runAgentTool("spawn_agent", { role: "exploit" }, ctx);
    expect(out).toContain("only the root agent");
  });

  it("spawn_agent forwards to ctx.spawn", async () => {
    const ctx = ctxWith({ spawn: async () => "child report" });
    const out = await runAgentTool("spawn_agent", { role: "recon", objective: "map ports" }, ctx);
    expect(out).toBe("child report");
  });

  it("notes records into ctx", async () => {
    const ctx = ctxWith();
    await runAgentTool("notes", { text: "target uses nginx" }, ctx);
    expect(ctx.notes[0]).toContain("nginx");
  });
});

// Mock callModel: simulates a model invoking tools. The offered tool set
// identifies whether root or a worker is running, allowing one mock to drive both.
function scriptedModel(script) {
  // Separate step counters per role: root and child run in the same loop.
  const counters = { root: 0, worker: 0 };
  return async (messages, tools) => {
    const name = tools.map((t) => t.function.name);
    const branch = name.includes("spawn_agent") ? "root" : "worker";
    const pick = script[branch];
    const index = counters[branch]++;
    const step = pick[Math.min(index, pick.length - 1)];
    if (!step) throw new Error("script exhausted");
    if (step.text) return { role: "assistant", content: step.text };
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `${branch}-${index}`, type: "function", function: { name: step.tool, arguments: step.args } },
      ],
    };
  };
}

describe("runAgent — root delegation to worker agents", () => {
  it("root spawns a worker agent and submits the final report", async () => {
    const state = createRunState();
    const callModel = scriptedModel({
      root: [
        { tool: "spawn_agent", args: JSON.stringify({ role: "recon", objective: "map ports", scope: "22/tcp" }) },
        { tool: "finish", args: JSON.stringify({ summary: "done", findings: [], not_tested: ["SSL not checked"] }) },
      ],
      worker: [
        { tool: "report_failure", args: JSON.stringify({ area: "port 443", reason: "closed" }) },
        { tool: "finish", args: JSON.stringify({ summary: "only 22 open", findings: [] }) },
      ],
    });

    const events = [];
    const result = await runAgent({
      role: "root",
      objective: "test target",
      target: "10.0.0.5",
      state,
      callModel,
      emit: (e) => events.push(e),
      maxSteps: 5,
    });

    expect(result.failed).toBe(false);
    expect(state.children).toHaveLength(1);
    expect(state.children[0].role).toBe("recon");
    expect(state.failures).toHaveLength(1);
    expect(result.report.notTested).toContain("SSL not checked");
    expect(events.some((e) => e.type === "agent_start" && e.agent === "recon-1")).toBe(true);
    expect(events.some((e) => e.type === "agent_end" && e.agent === "recon-1")).toBe(true);
  });

  it("records child failure in the ledger even when child never called report_failure", async () => {
    const state = createRunState();
    let firstWorkerCall = true;
    const callModel = scriptedModel({
      root: [
        { tool: "spawn_agent", args: JSON.stringify({ role: "recon", objective: "map all ports" }) },
        { tool: "finish", args: JSON.stringify({ summary: "ok", findings: [], not_tested: [] }) },
      ],
      worker: [],
    });
    // Child stops because it replied without tools — never called report_failure,
    // so the runtime must record the failure automatically.
    const wrapped = async (messages, tools) => {
      if (tools.map((t) => t.function.name).includes("spawn_agent")) return callModel(messages, tools);
      if (firstWorkerCall) {
        firstWorkerCall = false;
        return { role: "assistant", content: "I think that is enough" };
      }
      return callModel(messages, tools);
    };
    await runAgent({ role: "root", objective: "o", state, callModel: wrapped, maxSteps: 5 });
    expect(state.children[0].failed).toBe(true);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0].agent).toBe(state.children[0].name);
    expect(state.failures[0].area).toContain("map all ports");
  });

  it("does not double-record a child failure when the child already reported it", async () => {
    const state = createRunState();
    const callModel = scriptedModel({
      root: [
        { tool: "spawn_agent", args: JSON.stringify({ role: "recon", objective: "map" }) },
        { tool: "finish", args: JSON.stringify({ summary: "one child enough", findings: [], not_tested: [] }) },
      ],
      worker: [
        { tool: "report_failure", args: JSON.stringify({ area: "port 443", reason: "closed" }) },
        { tool: "notes", args: JSON.stringify({ text: "keep going" }) },
      ],
    });
    await runAgent({ role: "root", objective: "o", state, callModel, maxSteps: 4 });
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0].area).toBe("port 443");
  });

  it("prevents root from spawning more than six sub-agents", async () => {
    const state = createRunState();
    const callModel = scriptedModel({
      root: [{ tool: "spawn_agent", args: JSON.stringify({ role: "recon", objective: "x" }) }],
      worker: [{ tool: "finish", args: JSON.stringify({ summary: "ok", findings: [] }) }],
    });
    // Eight steps: 7th spawn is rejected by the cap.
    const result = await runAgent({ role: "root", objective: "o", state, callModel, maxSteps: 12 });
    expect(state.children.length).toBeLessThanOrEqual(6);
    expect(result.failed).toBe(true);
  });

  it("rejects unknown child roles through the actual spawn path", async () => {
    const state = createRunState();
    let sawRejection = false;
    const callModel = scriptedModel({
      root: [
        { tool: "spawn_agent", args: JSON.stringify({ role: "database-destroyer" }) },
        { tool: "finish", args: JSON.stringify({ summary: "done", findings: [], not_tested: [] }) },
      ],
      worker: [],
    });
    // Wrap callModel so the error message from spawn is observed.
    const wrapped = async (messages, tools) => {
      const message = await callModel(messages, tools);
      const last = messages[messages.length - 1];
      if (last?.role === "tool") sawRejection = String(last.content).includes("unknown role");
      return message;
    };
    const result = await runAgent({ role: "root", objective: "o", state, callModel: wrapped, maxSteps: 4 });
    expect(sawRejection).toBe(true);
    expect(state.children).toHaveLength(0);
    expect(result.failed).toBe(false);
  });

  it("nudges a model that replies without tools once, then fails", async () => {
    const state = createRunState();
    const callModel = async () => ({ role: "assistant", content: "I finished thinking about it" });
    const result = await runAgent({ role: "root", objective: "o", state, callModel, maxSteps: 6 });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("without finish");
  });

  it("reports exhausted step limit as failure rather than a fake report", async () => {
    const state = createRunState();
    const callModel = scriptedModel({
      root: [{ tool: "notes", args: JSON.stringify({ text: "keep going" }) }],
      worker: [],
    });
    const result = await runAgent({ role: "root", objective: "o", state, callModel, maxSteps: 3 });
    expect(result.failed).toBe(true);
    expect(result.report).toBe(null);
  });

  it("surfaces model errors as failures rather than unhandled exceptions", async () => {
    const state = createRunState();
    const callModel = async () => {
      throw new Error("provider down");
    };
    const result = await runAgent({ role: "root", objective: "o", state, callModel, maxSteps: 3 });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("provider down");
  });
});

describe("systemPrompt", () => {
  it("uses the matching role brief", () => {
    expect(systemPrompt("recon", {})).toContain("agent recon");
    expect(systemPrompt("exploit", {})).toContain("Proof of Concept");
  });

  it("includes delegation guidance for root but not for workers", () => {
    expect(systemPrompt("root", {})).toContain("exploit");
    expect(systemPrompt("recon", {})).not.toContain("Before spawning a sub-agent");
  });

  it("includes scope in the prompt", () => {
    expect(systemPrompt("recon", { target: "10.0.0.5", scope: "only 443" })).toContain("only 443");
  });
});