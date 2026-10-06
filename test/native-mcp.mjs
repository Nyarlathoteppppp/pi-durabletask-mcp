import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 1. In-process Fixture Branch: run when process.argv[2] === "fixture"
// ---------------------------------------------------------------------------
if (process.argv[2] === "fixture") {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const serverName = process.argv[3] || "unknown";
  const lifecycleFile = process.env.TEST_LIFECYCLE_FILE;
  const effectsFile = process.env.TEST_EFFECTS_FILE;

  if (lifecycleFile) {
    appendFileSync(lifecycleFile, `START:${serverName}:${process.pid}\n`);
  }

  const cleanup = () => {
    if (lifecycleFile) {
      appendFileSync(lifecycleFile, `STOP:${serverName}:${process.pid}\n`);
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  const server = new McpServer({
    name: `fixture-${serverName}`,
    version: "1.0.0",
  });

  server.tool(
    "echo",
    "Echo input text back",
    { message: z.string().describe("Message to echo") },
    async ({ message }) => ({
      content: [{ type: "text", text: `echo:${serverName}:${message}` }],
    }),
  );

  server.tool(
    "effect",
    "Side-effect tool that writes to file",
    { payload: z.string().describe("Payload to append") },
    async ({ payload }) => {
      if (effectsFile) {
        appendFileSync(effectsFile, `EFFECT:${serverName}:${payload}\n`);
      }
      return {
        content: [{ type: "text", text: `effect:${serverName}:${payload}` }],
      };
    },
  );

  server.resource("fixture-text", "fixture://text", async (uri) => ({
    contents: [{ uri: uri.href, text: "FIXTURE_RESOURCE" }],
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive until stdio closes or terminated
} else {
  // ---------------------------------------------------------------------------
  // 2. Integration Test Suite
  // ---------------------------------------------------------------------------
  const testScriptPath = fileURLToPath(import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), "pi-delegate-native-mcp-"));
  const lifecycleFile = join(dir, "lifecycle.log");
  const effectsFile = join(dir, "effects.log");

  const requests = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );

    const lastMsg = request.messages.filter(m => ["user", "assistant", "tool"].includes(m.role)).at(-1);
    const lastUser = request.messages.findLast((m) => m.role === "user");
    const userPrompt =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? "");

    if (userPrompt.includes("TRIGGER_DIRECT") && lastMsg?.role !== "tool") {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_direct_echo",
            type: "function",
            function: {
              name: "mcp__direct__echo",
              arguments: JSON.stringify({ message: "hello-direct" }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (userPrompt.includes("TRIGGER_CODEMODE_ALLOWED") && lastMsg?.role !== "tool") {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_codemode_allowed",
            type: "function",
            function: {
              name: "codemode",
              arguments: JSON.stringify({
                code: 'await tools.mcp__coded__echo({ message: "from-codemode" }); return "CODEMODE_OK";',
              }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (userPrompt.includes("TRIGGER_CODEMODE_BLOCKED_EFFECT") && lastMsg?.role !== "tool") {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_codemode_blocked",
            type: "function",
            function: {
              name: "codemode",
              arguments: JSON.stringify({
                code: userPrompt.includes("RESOURCE")
                  ? 'await searchTools("fixture"); text(await tools.list_mcp_resources({ server: "coded" }));'
                  : 'await tools.mcp__coded__effect({ payload: "illegal-mutation" }); return "HACKED";',
              }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (userPrompt.includes("TRIGGER_DEFERRED_SEARCH") && lastMsg?.role !== "tool") {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_tool_search",
            type: "function",
            function: {
              name: "tool_search",
              arguments: JSON.stringify({ query: "echo" }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (
      userPrompt.includes("TRIGGER_DEFERRED_SEARCH") &&
      lastMsg?.role === "tool" &&
      lastMsg?.tool_call_id === "call_tool_search"
    ) {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_deferred_echo",
            type: "function",
            function: {
              name: "mcp__deferred__echo",
              arguments: JSON.stringify({ message: "deferred-done" }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      const isToolResult = lastMsg?.role === "tool";
      emit({
        role: "assistant",
        content: isToolResult ? `RESULT_CONFIRMED: ${lastMsg.content}` : "DEFAULT_OK",
      });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });

  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const httpPort = http.address().port;

  const client = new Client({ name: "native-mcp-integration", version: "1" });

  try {
    const agentDir = join(dir, "agent");
    await mkdir(agentDir, { recursive: true });

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "test",
        defaultModel: "one",
        defaultThinkingLevel: "off",
        enabledModels: ["test/*"],
      }),
    );

    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: `http://127.0.0.1:${httpPort}/v1`,
            api: "openai-completions",
            apiKey: "fake-key",
            models: [{
              id: "one",
              name: "one",
              reasoning: false,
              input: ["text"],
              contextWindow: 16000,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }],
          },
        },
      }),
    );

    // Global mcp.json in agent dir configuring three servers with distinct exposures
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          direct: {
            command: process.execPath,
            args: [testScriptPath, "fixture", "direct"],
            exposure: "direct",
            description: "Direct echo server",
            env: {
              TEST_LIFECYCLE_FILE: lifecycleFile,
              TEST_EFFECTS_FILE: effectsFile,
            },
          },
          coded: {
            command: process.execPath,
            args: [testScriptPath, "fixture", "coded"],
            exposure: "codemode",
            description: "Codemode echo and effect server",
            env: {
              TEST_LIFECYCLE_FILE: lifecycleFile,
              TEST_EFFECTS_FILE: effectsFile,
            },
          },
          deferred: {
            command: process.execPath,
            args: [testScriptPath, "fixture", "deferred"],
            exposure: "deferred",
            description: "Deferred echo server",
            env: {
              TEST_LIFECYCLE_FILE: lifecycleFile,
              TEST_EFFECTS_FILE: effectsFile,
            },
          },
        },
      }),
    );

    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: agentDir,
          PI_DELEGATE_STATE_DIR: join(dir, "state"),
          PI_DELEGATE_MODEL: "test/one",
          PI_DELEGATE_ALLOW_WRITE: "0",
          PI_DELEGATE_ALLOW_TOOLS:
            "mcp__direct__echo,mcp__coded__echo,mcp__deferred__echo,codemode,tool_search,list_mcp_resources",
          PI_DELEGATE_IGNORE_SCOPE: "1",
        },
      }),
    );

    const raw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => {
      const result = await raw(name, args);
      assert.ok(!result.isError, result.content?.[0]?.text || "Tool call returned error");
      return JSON.parse(result.content[0].text);
    };

    await call("init", { cwd: dir });

    const readLifecycle = async () => {
      try {
        return await readFile(lifecycleFile, "utf-8");
      } catch {
        return "";
      }
    };

    // -------------------------------------------------------------------------
    // Scenario 1: Default native MCP is disabled -> no MCP child process launched
    // -------------------------------------------------------------------------
    console.log("[1] Default native MCP off: no connections");
    const s1 = await call("run", {
      cwd: dir,
      prompt: "TRIGGER_DEFAULT: check default",
      tools: [],
    });
    assert.equal(s1.state, "done");
    const log1 = await readLifecycle();
    assert.equal(log1, "", "No MCP server should start when nativeMcp is omitted");

    // -------------------------------------------------------------------------
    // Scenario 2: nativeMcp: true without mcpServers or empty -> rejected
    // -------------------------------------------------------------------------
    console.log("[2] nativeMcp: true without non-empty mcpServers: rejected");
    const r2a = await raw("run", {
      cwd: dir,
      prompt: "should fail",
      nativeMcp: true,
      tools: ["mcp__direct__echo"],
    });
    assert.equal(r2a.isError, true, "nativeMcp without mcpServers must fail");

    const r2b = await raw("run", {
      cwd: dir,
      prompt: "should fail",
      nativeMcp: true,
      mcpServers: [],
      tools: ["mcp__direct__echo"],
    });
    assert.equal(r2b.isError, true, "nativeMcp with empty mcpServers must fail");

    const countBefore = (await call("sessions")).count;
    const requestsBefore = requests.length;
    const invalidBatch = await raw("spawn_batch", { cwd: dir, nativeMcp: true, mcpServers: ["direct"],
      tasks: [{ prompt: "TRIGGER_DIRECT", tools: ["mcp__direct__echo"] },
        { prompt: "invalid", mcpServers: ["missing-server"], tools: ["mcp__direct__echo"] }] });
    assert.equal(invalidBatch.isError, true);
    assert.equal((await call("sessions")).count, countBefore);
    assert.equal(requests.length, requestsBefore, "native batch config is validated before any model runs");
    assert.equal((await raw("run", { cwd: dir, prompt: "invalid", nativeMcp: true,
      mcpServers: ["coded"], tools: ["mcp__coded__effect"] })).isError, true);

    // -------------------------------------------------------------------------
    // Scenario 3: tools: [] with nativeMcp does not load native factory/tools
    // -------------------------------------------------------------------------
    console.log("[3] tools: [] with nativeMcp: activeTools empty, no MCP factory");
    const s3 = await call("run", {
      verbose: true,
      cwd: dir,
      prompt: "tools: [] test",
      nativeMcp: true,
      mcpServers: ["direct"],
      tools: [],
    });
    assert.deepEqual(s3.activeTools, []);

    // -------------------------------------------------------------------------
    // Scenario 4: extensions: false with native direct MCP works
    // -------------------------------------------------------------------------
    console.log("[4] extensions: false with direct native MCP: callable");
    const s4 = await call("run", {
      verbose: true,
      id: "sess-direct",
      cwd: dir,
      prompt: "TRIGGER_DIRECT: call direct echo",
      nativeMcp: true,
      mcpServers: ["direct"],
      extensions: false,
      tools: ["mcp__direct__echo"],
      maxTurns: 5,
    });
    assert.equal(s4.state, "done");
    assert.ok(s4.toolCalls.some((tc) => tc.name === "mcp__direct__echo" && tc.state === "ok"));
    assert.match(s4.lastText, /echo:direct:hello-direct/);
    const log4 = await readLifecycle();
    assert.match(log4, /START:direct:/);

    // -------------------------------------------------------------------------
    // Scenario 5: Unselected servers do not start
    // -------------------------------------------------------------------------
    console.log("[5] Unselected servers are not started");
    assert.doesNotMatch(log4, /START:coded:/);
    assert.doesNotMatch(log4, /START:deferred:/);

    // -------------------------------------------------------------------------
    // Scenario 6: Codemode nested call to allowed native tool succeeds
    // -------------------------------------------------------------------------
    console.log("[6] Codemode nested allowed tool succeeds");
    const s6 = await call("run", {
      verbose: true,
      cwd: dir,
      prompt: "TRIGGER_CODEMODE_ALLOWED: call coded echo via codemode",
      nativeMcp: true,
      mcpServers: ["coded"],
      extensions: false,
      tools: ["codemode", "mcp__coded__echo"],
      maxTurns: 5,
    });
    assert.equal(s6.state, "done");
    assert.ok(s6.toolCalls.some((tc) => tc.name === "codemode" && tc.state === "ok"));
    assert.ok(s6.toolCalls.some((tc) => tc.name === "mcp__coded__echo" && tc.state === "ok"));
    assert.match(s6.lastText, /CODEMODE_OK/);

    // -------------------------------------------------------------------------
    // Scenario 7: Codemode nested unauthorized effect tool is rejected & no file created
    // -------------------------------------------------------------------------
    console.log("[7] Codemode nested unauthorized effect tool rejected");
    const s7 = await call("run", {
      verbose: true,
      cwd: dir,
      prompt: "TRIGGER_CODEMODE_BLOCKED_EFFECT: try unauthorized effect tool",
      nativeMcp: true,
      mcpServers: ["coded"],
      extensions: false,
      tools: ["codemode", "mcp__coded__echo"], // effect tool omitted from whitelist & not permitted
      maxTurns: 5,
    });
    assert.ok(s7.toolCalls.some(tc => tc.name === "codemode" && tc.state === "error"));
    assert.match(s7.lastText, /mcp__coded__effect does not exist/);
    let effectFileExists = false;
    try {
      await readFile(effectsFile, "utf-8");
      effectFileExists = true;
    } catch {
      effectFileExists = false;
    }
    assert.equal(effectFileExists, false, "Unauthorized effect must not write to effects file");

    console.log("[7b] Codemode/search without named MCP tools cannot inherit server tools");
    for (const tools of [["codemode"], ["codemode", "tool_search"]]) {
      const blocked = await call("run", { cwd: dir, verbose: true, nativeMcp: true, mcpServers: ["coded"],
        prompt: "TRIGGER_CODEMODE_BLOCKED_EFFECT", tools, maxTurns: 5 });
      assert.match(blocked.lastText, /mcp__coded__effect does not exist/);
      assert.ok(blocked.toolCalls.some(tc => tc.name === "codemode" && tc.state === "error"));
      await assert.rejects(readFile(effectsFile, "utf8"), { code: "ENOENT" });
    }

    console.log("[7c] MCP resource tools also require explicit authorization");
    const blockedResource = await call("run", { cwd: dir, nativeMcp: true, mcpServers: ["coded"],
      prompt: "TRIGGER_CODEMODE_BLOCKED_EFFECT RESOURCE", tools: ["codemode"], maxTurns: 5 });
    assert.match(blockedResource.lastText, /list_mcp_resources does not exist/);
    const allowedResource = await call("run", { cwd: dir, nativeMcp: true, mcpServers: ["coded"],
      prompt: "TRIGGER_CODEMODE_BLOCKED_EFFECT RESOURCE", tools: ["codemode", "list_mcp_resources"], maxTurns: 5 });
    assert.match(allowedResource.lastText, /fixture-text/);

    // -------------------------------------------------------------------------
    // Scenario 8: tool_search (deferred exposure) search and call
    // -------------------------------------------------------------------------
    console.log("[8] tool_search discovers and calls deferred native tool");
    const s8 = await call("run", {
      verbose: true,
      cwd: dir,
      prompt: "TRIGGER_DEFERRED_SEARCH: search echo then call it",
      nativeMcp: true,
      mcpServers: ["deferred"],
      extensions: false,
      tools: ["tool_search", "mcp__deferred__echo"],
      maxTurns: 5,
    });
    assert.equal(s8.state, "done");
    assert.ok(s8.toolCalls.some((tc) => tc.name === "tool_search"));
    assert.ok(s8.toolCalls.some((tc) => tc.name === "mcp__deferred__echo"));

    const searchOnly = await call("run", { cwd: dir, verbose: true, nativeMcp: true, mcpServers: ["deferred"],
      prompt: "TRIGGER_DEFERRED_SEARCH", tools: ["tool_search"], maxTurns: 5 });
    assert.match(searchOnly.lastText, /Tool mcp__deferred__echo not found/);
    assert.ok(!searchOnly.toolCalls.some(tc => tc.name === "mcp__deferred__echo" && tc.state === "ok"),
      "search does not authorize unnamed MCP tools");

    // -------------------------------------------------------------------------
    // Scenario 9: forget closes corresponding MCP child process
    // -------------------------------------------------------------------------
    console.log("[9] forget closes MCP child process");
    await call("forget", { sessionId: "sess-direct" });

    // Allow process termination signals to flush to lifecycle file
    let closed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const logAfter = await readLifecycle();
      if (/STOP:direct:/.test(logAfter)) {
        closed = true;
        break;
      }
    }
    assert.ok(closed, "Direct MCP process must be terminated and recorded on forget");

    const batch = await call("spawn_batch", { cwd: dir, nativeMcp: true, mcpServers: ["direct"],
      tasks: [{ id: "batch-native", prompt: "TRIGGER_DIRECT", tools: ["mcp__direct__echo"] },
        { id: "batch-off", prompt: "DEFAULT", nativeMcp: false, mcpServers: [], tools: [] }] });
    assert.equal(batch.started, 2);
    for (const id of ["batch-native", "batch-off"]) {
      let status;
      do { status = await call("wait", { sessionId: id, timeoutMs: 1000 }); }
      while (["starting", "running"].includes(status.state));
      assert.equal(status.state, "done");
      if (id === "batch-native") assert.match(status.lastText, /echo:direct:hello-direct/);
      else assert.deepEqual((await call("status", { sessionId: id })).activeTools, []);
      await call("forget", { sessionId: id });
    }

    console.log("[10] Trusted project overrides preserve the global transport");
    await mkdir(join(dir, ".pi"));
    new ProjectTrustStore(agentDir).set(dir, true);
    const projectConfig = join(dir, ".pi", "mcp.json");
    const globalConfig = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
    globalConfig.mcpServers.direct.enabled = false;
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify(globalConfig));
    await writeFile(projectConfig, JSON.stringify({ mcpServers: {
      direct: { enabled: true, exposure: "direct", toolExposure: { echo: "direct" } },
    } }));
    const overridden = await call("run", { cwd: dir, nativeMcp: true, mcpServers: ["direct"],
      prompt: "TRIGGER_DIRECT", tools: ["mcp__direct__echo"], maxTurns: 5 });
    assert.equal(overridden.state, "done", overridden.error);
    assert.match(overridden.lastText, /echo:direct:hello-direct/, "the override keeps command, args and env");

    await writeFile(projectConfig, JSON.stringify({ mcpServers: { direct: { enabled: false } } }));
    const disabled = await raw("spawn", { cwd: dir, nativeMcp: true, mcpServers: ["direct"], prompt: "x" });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /disabled/);

    await writeFile(projectConfig, JSON.stringify({ mcpServers: { missing: { exposure: "direct" } } }));
    const missingBase = await raw("spawn", { cwd: dir, nativeMcp: true, mcpServers: ["missing"], prompt: "x" });
    assert.equal(missingBase.isError, true, "an override needs a global server");

    await writeFile(projectConfig, JSON.stringify({ mcpServers: { direct: {
      exposure: "direct", auth: { provider: "test" },
    } } }));
    const credentials = await raw("spawn", { cwd: dir, nativeMcp: true, mcpServers: ["direct"], prompt: "x" });
    assert.equal(credentials.isError, true, "project overrides cannot add authentication or other transport fields");
    console.log("  OK -> native direct/codemode/deferred calls, opt-in, precise permissions, batch inheritance and transport cleanup");
  } finally {
    await client.close();
    await new Promise((resolve) => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
