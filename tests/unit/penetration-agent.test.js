import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, AGENT_TOOL_NAMES, runAgentTool } from "../../src/shared/lib/agentTools.js";
import { runInSandbox, stopSandbox } from "../../src/shared/lib/pentestSandbox.js";

// 9router-lith penetration agent: tool-calling loop + podman sandbox.
// Tests properties that could silently break without surfacing in the UI:
// argument dispatch from the model, clean termination, and enforced timeouts.

function freshCtx(overrides = {}) {
  return {
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: "root",
    notes: [],
    evidence: [],
    failures: [],
    finished: false,
    report: null,
    ...overrides,
  };
}

describe("tool schema", () => {
  it("gives the root agent its tool set with valid OpenAI shape", () => {
    expect(AGENT_TOOL_NAMES.sort()).toEqual([
      "finish",
      "load_skill",
      "notes",
      "shell",
      "spawn_agent",
    ]);
    for (const tool of AGENT_TOOLS) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(typeof tool.function.description).toBe("string");
      expect(tool.function.parameters.type).toBe("object");
    }
  });
});

describe("runAgentTool dispatch", () => {
  it("rejects a shell call with no command instead of running an empty string", async () => {
    const out = await runAgentTool("shell", { command: "   " }, freshCtx());
    expect(out).toContain("ERROR");
  });

  it("survives malformed JSON arguments from the model", async () => {
    // Models emit truncated JSON mid-stream more often than anyone likes.
    const out = await runAgentTool("notes", "{not json", freshCtx());
    expect(out).toContain("ERROR");
  });

  it("records notes and reports the running total", async () => {
    const ctx = freshCtx();
    await runAgentTool("notes", { text: "port 22 open" }, ctx);
    await runAgentTool("notes", { text: "sqlmap: injectable" }, ctx);
    expect(ctx.notes).toEqual(["port 22 open", "sqlmap: injectable"]);
  });

  it("captures the report and ends the run when finish is called", async () => {
    const ctx = freshCtx({
      evidence: [{ id: 1, command: "curl -i http://t/", output: "HTTP/1.1 200 OK\nSQL syntax error" }],
    });
    await runAgentTool("finish", {
      summary: "1 high finding",
      findings: [
        {
          title: "SQLi",
          severity: "high",
          evidence_ids: [1],
          evidence_quote: "SQL syntax error",
        },
      ],
      not_tested: [],
    }, ctx);
    expect(ctx.finished).toBe(true);
    expect(ctx.report.summary).toBe("1 high finding");
    expect(ctx.report.findings).toHaveLength(1);
  });

  it("will not end the run on a finding nobody can prove", async () => {
    const ctx = freshCtx();
    await runAgentTool(
      "finish",
      { summary: "SQLi!", findings: [{ title: "SQLi", severity: "critical" }] },
      ctx
    );
    expect(ctx.finished).toBe(false);
    expect(ctx.report).toBe(null);
  });

  it("rejects an unknown tool by name rather than crashing", async () => {
    const out = await runAgentTool("rm_rf", {}, freshCtx());
    expect(out).toContain("unknown tool");
  });
});

describe("load_skill", () => {
  it("resolves loose spellings the model is likely to produce", async () => {
    for (const name of ["sql_injection", "sql-injection", "SQL Injection", "vulnerabilities/sql_injection"]) {
      const out = await runAgentTool("load_skill", { name }, freshCtx());
      expect(out, `failed for: ${name}`).not.toContain("unknown skill");
      expect(out.length).toBeGreaterThan(200);
    }
  });

  it("lists the available catalog when the name is unknown", async () => {
    const out = await runAgentTool("load_skill", { name: "definitely_not_a_skill" }, freshCtx());
    expect(out).toContain("unknown skill");
    expect(out).toContain("Available:");
  });
});

// ── Sandbox: requires 9router-pentest image. Skip if not built yet. ──
const image = process.env.PENTEST_IMAGE || "docker.io/local/9router-pentest:latest";
async function imagePresent() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    await promisify(execFile)("podman", ["image", "inspect", image], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const hasImage = await imagePresent();
const maybe = hasImage ? describe : describe.skip;

if (!hasImage) {
  console.warn(`[pentest-agent] image ${image} not built — skipping sandbox tests`);
}

maybe("sandbox", () => {
  it("runs a command as a non-root user and captures stdout", async () => {
    const ctx = freshCtx();
    try {
      const result = await runInSandbox(ctx.sessionId, "echo hello && whoami");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("hello");
      expect(result.output).toContain("pentester");
      expect(result.output).not.toContain("root");
    } finally {
      await stopSandbox(ctx.sessionId);
    }
    // First container creation + Kali boot takes several seconds, exceeding Vitest's 5s default.
  }, 45_000);

  it("enforces the timeout instead of waiting for the command to finish", async () => {
    const ctx = freshCtx();
    const started = Date.now();
    try {
      const result = await runInSandbox(ctx.sessionId, "sleep 30", { timeout: 1_500 });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      // coreutils timeout + kill grace; the point is it is nowhere near 30s.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await stopSandbox(ctx.sessionId);
    }
  }, 40_000);

  it("passes a non-zero exit code back instead of throwing", async () => {
    const ctx = freshCtx();
    try {
      const result = await runInSandbox(ctx.sessionId, "exit 3");
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(3);
    } finally {
      await stopSandbox(ctx.sessionId);
    }
  }, 45_000);

  it("truncates runaway output so one command cannot blow up the context", async () => {
    const ctx = freshCtx();
    try {
      // seq 1 30000 ≈ 150KB — deterministic and independent of podman relay speed.
      const result = await runInSandbox(ctx.sessionId, "seq 1 30000", { timeout: 10_000 });
      expect(result.output.length).toBeLessThanOrEqual(60_000);
      // Without this marker the model assumes the output was complete rather than truncated.
      expect(result.output).toContain("truncated");
    } finally {
      await stopSandbox(ctx.sessionId);
    }
  }, 45_000);
});