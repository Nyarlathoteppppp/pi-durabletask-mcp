import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.argv[2] === "exa-fixture" || process.argv[2] === "member-fixture") {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const fixture = new McpServer({ name: "exa", version: "1" });
  fixture.registerTool("web_search_exa", { inputSchema: { query: z.string(), objective: z.string() }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "SEARCH PRIMARY SOURCE" }] }));
  fixture.registerTool("web_fetch_exa", { inputSchema: { urls: z.array(z.string()) }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "FETCH OFFICIAL EVIDENCE" }] }));
  fixture.registerTool("effect", { inputSchema: {} }, async () => { throw new Error("unauthorized effect must never execute"); });
  if (process.argv[2] === "member-fixture") {
    for (const name of ["get_file_contents", "find_symbol", "agent_browser_snapshot"])
      fixture.registerTool(name, { inputSchema: {} }, async () => ({content:[{type:"text",text:`MEMBER EVIDENCE ${name}`}]}));
    fixture.registerTool("agent_browser_fill", {inputSchema:{}}, async()=>{throw new Error("team form entry must never execute");});
  }
  await fixture.connect(new StdioServerTransport());
  await new Promise((resolve) => process.stdin.on("end", resolve));
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "pi-coordinator-"));
const sockets = new Set();
const inherited = [];
const targetReports = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const users = request.messages.filter((m) => m.role === "user");
  const prompt = JSON.stringify(users.at(-1)?.content ?? ""); // Pi omits an explicitly empty user message.
  // Capture the actual codemode reply seen by the provider; diagnostic traces are clipped.
  if (prompt.includes("TARGET_COORDINATOR") && request.messages.at(-1).role === "tool") {
    const text = request.messages.at(-1).content;
    const value = JSON.parse(text.split("\nOutput:\n\n").at(-1));
    if (value?.original) {
      if (!targetReports.length) targetReports.push(value.original);
      if (value.updated) targetReports.push(value.updated);
    }
  }
  if (prompt.includes("FAIL_CHILD")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "intentional child failure" } })); return;
  }
  if (prompt.includes("SLOW_CHILD")) return; // held until this child's ordinary abort
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "coord", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const tool = (name, args) => {
    emit({ role: "assistant", tool_calls: [{ index: 0, id: `call-${request.messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    emit({}, "tool_calls");
  };
  const answer = (content) => { emit({ role: "assistant", content }); emit({}, "stop"); };
  const scripts = request.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).filter((c) => c.function.name === "codemode").length;
  if (prompt.includes("SCHEMA_PROBE")) {
    if (!scripts) tool("codemode", { code: 'return await Promise.all(["delegate_start_batch","delegate_wait","delegate_get","delegate_follow_up"].map(name=>describeTool(name)));' });
    else answer("DECLARATIONS " + request.messages.at(-1).content);
  } else if (prompt.includes("INDEX_REFRESH")) {
    if (request.messages.at(-1).role === "user") tool("codemode", { code: 'return await tools.delegate_wait({timeoutMs:0});' });
    else answer("INDEX REFRESH DONE");
  } else if (prompt === '""') {
    answer("EMPTY PROMPT PRESERVED");
  } else if (prompt.includes("ATTACH_COORDINATOR")) {
    if (!scripts) tool("codemode", {code:'const b=await tools.delegate_start_batch({}); await tools.delegate_wait({timeoutMs:5000}); const r=await Promise.all(b.sessionIds.map(sessionId=>tools.delegate_get({sessionId}))); return r.map(x=>x.label+":"+x.lastText);'});
    else answer(`ATTACHED ${JSON.stringify(request.messages.at(-1).content)}`);
  } else if (prompt.includes("ATTACH_CHILD")) {
    answer(prompt.includes("ATTACHED_MARK") ? "HAS_FILE" : "NO_FILE");
  } else if (prompt.includes("PARALLEL_COORDINATOR")) {
    if (!scripts) tool("codemode", {code:'const [b,w]=await Promise.all([tools.delegate_start_batch({}),tools.delegate_wait({timeoutMs:5000})]); return {started:b.sessionIds.length,waited:w.sessions.length};'});
    else answer(`PARALLEL ${JSON.stringify(request.messages.at(-1).content)}`);
  } else if (prompt.includes("TARGET_COORDINATOR")) {
    if (!scripts) tool("codemode", {code:'const b=await tools.delegate_start_batch({}); store("target.batch",b); return b;'});
    else if (scripts === 1) tool("codemode", {code:'const b=load("target.batch"); await tools.delegate_wait({timeoutMs:1000}); const r=await tools.delegate_get({sessionId:b.sessionIds[0]}); store("target.original",r); const renewed=await tools.delegate_follow_up({sessionId:r.sessionId,prompt:"TARGET_ANSWER: give the final verified conclusion",maxTurns:2,maxToolCalls:1}); return {original:r,renewed};'});
    else if (scripts === 2) tool("codemode", {code:'await tools.delegate_wait({timeoutMs:1000}); const old=load("target.original"); const updated=await tools.delegate_get({sessionId:old.sessionId}); return {original:old,updated};'});
    else answer(JSON.stringify(request.messages.at(-1).content));
  } else if (prompt.includes("TARGET_ANSWER")) {
    answer("VERIFIED FOLLOW-UP ALPHA");
  } else if (prompt.includes("CHILD_TARGET")) {
    answer("INITIAL ALPHA");
  } else if (prompt.includes("COORDINATOR") || prompt.includes("Coordinate the caller's approved task plan")) {
    assert.ok(request.tools.every((t) => !t.function.name.startsWith("delegate_")), "child tools are script-only, not direct declarations");
    if (!scripts) tool("codemode", { code: 'try { await tools.delegate_get({ sessionId: "facts" }); return "BAD foreign read"; } catch(e) { const b = await tools.delegate_start_batch({}); store("batch", b); return {blocked: e.message, batch:b}; }' });
    else if (scripts === 1) tool("codemode", { code: 'const b=load("batch"); const w=await tools.delegate_wait({sessionIds:b.sessionIds,timeoutMs:1000}); const reports=await Promise.all(b.sessionIds.map(sessionId=>tools.delegate_get({sessionId}))); store("reports",reports); return {states:reports.map(r=>({id:r.sessionId,state:r.state,error:r.error})),wait:w};' });
    else if (scripts === 2) tool("codemode", { code: 'const reports=load("reports"); const repeated=await tools.delegate_start_batch({}); return { reports, repeated };' });
    else answer(`FINAL ${JSON.stringify(request.messages.at(-1).content)}`);
  } else if (prompt.includes("OVERFLOW")) {
    if (!scripts) tool("codemode", { code: 'try {return await tools.delegate_start_batch({});} catch(e) {return e.message;}' });
    else answer(JSON.stringify(request.messages.at(-1).content));
  } else if (prompt.includes("CANCEL_PARENT")) {
    if (!scripts) tool("codemode", { code: 'const b=await tools.delegate_start_batch({}); store("batch",b); return b;' });
    else tool("codemode", { code: 'return await tools.delegate_wait({timeoutMs:55000});' });
  } else if (prompt.includes("RECEIPT_RECOVERY")) {
    if (!scripts) tool("codemode", { code: 'const b=await tools.delegate_start_batch({}); store("receipt",b); await tools.delegate_wait({timeoutMs:120000}); return "UNREACHABLE";' });
    else if (scripts === 1) tool("codemode", { code: 'const rec=load("receipt"); const probe=await tools.delegate_wait({timeoutMs:0}); const s0=probe.sessions[0]; await tools.delegate_wait({sessionIds:[s0.sessionId],timeoutMs:1000}); const rep=await tools.delegate_get({sessionId:s0.sessionId}); const repeated=await tools.delegate_start_batch({}); return {storeDiscarded:rec===undefined,wait0Ok:probe.sessions?.length===1,reportOk:Boolean(rep.savedTo),started:repeated.started,sameId:repeated.sessionIds[0]===s0.sessionId};' });
    else answer("RECEIPT RECOVERY OK");
  } else if (prompt.includes("CHILD_RECEIPT")) {
    answer("RECEIPT REPORT ALPHA");
  } else if (prompt.includes("CHILD_MCP")) {
    const expected = prompt.includes("GITHUB") ? "mcp__github__get_file_contents" : prompt.includes("SERENA") ? "mcp__serena__find_symbol" : "mcp__browser__agent_browser_snapshot";
    assert.deepEqual((request.tools ?? []).map(t=>t.function.name),[expected],"member sees only its explicitly selected tool, including on follow-up");
    if(request.messages.at(-1).role !== "tool") tool(expected,{});
    else answer("CHILD REPORT "+request.messages.at(-1).content);
  } else if (prompt.includes("CHILD_WEB")) {
    const names = (request.tools ?? []).map((t) => t.function.name);
    assert.ok(!names.includes("mcp__exa__effect") && !names.includes("codemode"), "research grants only exact search/fetch");
    const previous = request.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
    if (!previous.includes("mcp__exa__web_search_exa")) tool("mcp__exa__web_search_exa", { query: "official docs", objective: "verify semantics" });
    else if (!previous.includes("mcp__exa__web_fetch_exa")) tool("mcp__exa__web_fetch_exa", { urls: ["https://example.com/docs"] });
    else answer("CHILD REPORT " + JSON.stringify(request.messages.at(-1).content));
  } else if (prompt.includes("CHILD")) {
    inherited.push(request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("ALPHA")));
    answer("CHILD REPORT ALPHA " + "evidence ".repeat(230));
  } else if (prompt.includes("NO_COORD")) {
    if (!scripts) tool("codemode", { code: 'try {return await tools.delegate_start_batch({});} catch(e) {return "UNAVAILABLE " + e.message;}' });
    else answer(JSON.stringify(request.messages.at(-1).content));
  } else if (request.messages.at(-1).role !== "tool") tool("read", { path: "a.txt" });
  else answer("FACTS ALPHA");
  res.end("data: [DONE]\n\n");
});
http.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const client = new Client({ name: "coordinator", version: "1" });
try {
  const agentDir = join(dir, "agent"); await mkdir(agentDir);
  await writeFile(join(dir, "a.txt"), "ALPHA\n");
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { exa: {
    command: process.execPath, args: [join(process.cwd(), "test/coordinator.mjs"), "exa-fixture"], exposure: "direct",
  }, ...Object.fromEntries(["github","serena","browser"].map(name=>[name,{
    command:process.execPath,args:[join(process.cwd(),"test/coordinator.mjs"),"member-fixture"],exposure:"direct",
  }])) } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "one", enabledModels: ["test/*"] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore", env: {
    ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DELEGATE_STATE_DIR: join(dir, "state"),
    PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1", PI_DELEGATE_ALLOW_TOOLS: "codemode,write,mcp__exa__web_search_exa,mcp__exa__web_fetch_exa,mcp__github__get_file_contents,mcp__serena__find_symbol,mcp__browser__agent_browser_snapshot,mcp__browser__agent_browser_fill", PI_DELEGATE_MAX_CONCURRENT: "4",
  } }));
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  const settle = async (id) => { let r; do r = await call("wait", { sessionId: id, until: "settled", timeoutMs: 15000 }); while (r.nextAction === "wait"); return r; };
  const declarations = await call("run", { cwd: dir, prompt: "SCHEMA_PROBE", coordinator: { tasks: [{ prompt: "not launched" }] }, maxTurns: 3 });
  assert.match(declarations.lastText, /sessionIds.*string/);
  assert.match(declarations.lastText, /continueIds.*string/);
  assert.match(declarations.lastText, /lastText.*string/);
  assert.match(declarations.lastText, /turnsSoFar.*number/);
  await call("spawn", { cwd: dir, id: "facts", prompt: "FACT", tools: ["read"], maxTurns: 3 });
  await settle("facts");
  const coordinator = { forkFrom: "facts", saveDir: join(dir, "reports"), tasks: [
    { prompt: "CHILD_A", label: "a", tools: [], maxTurns: 2 },
    { prompt: "FAIL_CHILD", label: "failure", tools: [], maxTurns: 2 },
  ] };
  await call("spawn", { cwd: dir, id: "boss", prompt: "COORDINATOR", tools: ["codemode"], coordinator, maxTurns: 6 });
  const boss = await settle("boss");
  assert.equal(boss.state, "done", boss.error);
  assert.match(boss.lastText, /CHILD REPORT ALPHA/);
  const full = await call("status", { sessionId: "boss", verbose: true });
  const started = full.toolCalls.find((t) => t.name === "delegate_start_batch");
  assert.equal(started.state, "ok", JSON.stringify(started));
  // Tool trace results are intentionally shortened; check the persisted team projection instead.
  const indexes = (await readdir(coordinator.saveDir)).filter((p) => /^team-.*\.json$/.test(p));
  assert.equal(indexes.length, 1);
  const reportIndex = join(coordinator.saveDir, indexes[0]);
  assert.equal(boss.reportIndex, reportIndex);
  assert.equal(full.reportIndex, reportIndex);
  assert.equal((await call("wait", { sessionId: "boss", until: "settled" })).reportIndex, reportIndex);
  assert.equal((await call("wait", { sessionId: "boss", until: "settled", verbose: true })).reportIndex, reportIndex);
  assert.equal((await call("wait", { sessionIds: ["boss"], until: "all_settled" })).sessions[0].reportIndex, reportIndex);
  // A normal follow-up that performs no report publication retains the session's index.
  await call("follow_up", { sessionId: "boss", prompt: "short follow-up", maxTurns: 2 });
  assert.equal((await settle("boss")).reportIndex, reportIndex);
  // A later write failure preserves the previous receipt but exposes that it is stale.
  await rm(reportIndex);
  await mkdir(reportIndex);
  await call("follow_up", { sessionId: "boss", prompt: "INDEX_REFRESH", maxTurns: 3, maxToolCalls: 3 });
  const failedPublication = await settle("boss");
  assert.equal(failedPublication.state, "done", "index IO does not fail the execution");
  assert.equal(failedPublication.reportIndex, reportIndex);
  assert.equal(typeof failedPublication.reportIndexError, "string");
  assert.equal(typeof (await call("wait", { sessionIds: ["boss"] })).sessions[0].reportIndexError, "string");
  await rm(reportIndex, { recursive: true });
  await call("follow_up", { sessionId: "boss", prompt: "INDEX_REFRESH", maxTurns: 3, maxToolCalls: 3 });
  const republished = await settle("boss");
  assert.equal(republished.reportIndex, reportIndex);
  assert.equal(republished.reportIndexError, undefined, "successful publication clears the old error");
  const savedTeam = JSON.parse(await readFile(join(coordinator.saveDir, indexes[0]), "utf8"));
  const batch = { sessionIds: savedTeam.tasks.map((s) => s.sessionId), sessions: savedTeam.tasks };
  assert.deepEqual(savedTeam.tasks.map((s) => s.state), ["done", "error"]);
  assert.equal(batch.sessionIds.length, 2);
  assert.deepEqual(batch.sessions.map((s) => s.taskIndex), [0, 1]);
  for (const id of batch.sessionIds) {
    const state = await call("status", { sessionId: id, verbose: true });
    assert.deepEqual(state.activeTools, []);
    assert.equal(state.durable, false);
    assert.equal(state.toolCallCount, 0);
    assert.equal(state.forkedFrom, "facts");
    assert.equal(state.turns, 1, "fork budgets start fresh");
    if (state.label === "a") {
      assert.equal(state.state, "done");
      assert.match(await readFile(state.savedTo, "utf8"), /CHILD REPORT ALPHA/);
    } else { assert.equal(state.state, "error"); assert.match(state.error, /intentional child failure/); }
  }
  assert.deepEqual(inherited, [true], "child reuses inherited evidence without re-reading it");
  const waiting = full.toolCalls.find((t) => t.name === "delegate_wait");
  assert.equal(waiting.state, "ok");
  assert.doesNotMatch(waiting.result, /lastText/, "waiting avoids reprinting reports");
  assert.match(boss.lastText, /intentional child failure/, "a failed child stays visible");
  assert.equal(full.toolCalls.filter((t) => t.name === "delegate_start_batch").length, 2);
  assert.equal((await call("sessions", {})).sessions.filter((s) => ["a", "failure"].includes(s.label)).length, 2, "repeat default dispatch does not duplicate children");

  // Short team requests share the same core through spawn, run and batch. Defaults
  // must precede fork inheritance; an ordinary read-only parent cannot replace codemode.
  const shortPlan = { tasks: [{ prompt: "CHILD_TARGET", tools: [], maxTurns: 1 }] };
  const short = await call("spawn", { id: "short-boss", forkFrom: "facts", coordinator: shortPlan, maxTurns: 6 });
  assert.deepEqual(short.activeTools, ["codemode"]);
  assert.equal((await settle(short.sessionId)).state, "done");
  const shortRun = await call("run", { cwd: dir, coordinator: shortPlan, maxTurns: 6 });
  assert.equal(shortRun.state, "done", shortRun.error);
  const shortBatch = await call("spawn_batch", { cwd: dir, coordinator: shortPlan, maxTurns: 6, tasks: [{ id: "short-batch-boss" }] });
  assert.equal((await settle(shortBatch.sessionIds[0])).state, "done");
  const explicitEmpty = await call("run", { cwd: dir, coordinator: shortPlan, prompt: "", maxTurns: 2 });
  assert.equal(explicitEmpty.lastText, "EMPTY PROMPT PRESERVED", "an explicit empty prompt is not replaced");
  const overrideBatch = await call("spawn_batch", { cwd: dir, coordinator: shortPlan, tools: ["read"], maxTurns: 6,
    tasks: [{ id: "override-boss", tools: ["codemode"] }] });
  assert.equal((await settle(overrideBatch.sessionIds[0])).state, "done", "task tools override batch tools");
  for (const [name, args] of [
    ["spawn", { cwd: dir }], ["run", { cwd: dir }],
    ["spawn_batch", { cwd: dir, tasks: [{}, { prompt: "never launched", id: "missing-prompt-sibling" }] }],
    ["spawn", { cwd: dir, coordinator: shortPlan, tools: [] }],
    ["spawn_batch", { cwd: dir, coordinator: shortPlan, tools: ["read"], tasks: [{}] }],
  ]) assert.equal((await raw(name, args)).isError, true, `${name} rejects missing task or disabled codemode`);
  assert.equal((await raw("status", { sessionId: "missing-prompt-sibling" })).isError, true, "invalid batch launches no sibling");

  // Attachments: a plan-level default goes to every member; a member's own list replaces it, [] for none.
  await writeFile(join(dir, "shared.diff"), "ATTACHED_MARK diff\n");
  await call("spawn", {cwd:dir,id:"attach-boss",prompt:"ATTACH_COORDINATOR",tools:["codemode"],maxTurns:4,
    coordinator:{attachments:[join(dir,"shared.diff")],tasks:[{prompt:"ATTACH_CHILD",label:"with",tools:[],maxTurns:1},
      {prompt:"ATTACH_CHILD",label:"without",tools:[],maxTurns:1,attachments:[]}]} });
  const attachBoss=await settle("attach-boss");
  assert.equal(attachBoss.state,"done",attachBoss.error);
  assert.match(attachBoss.lastText,/with:HAS_FILE/);
  assert.match(attachBoss.lastText,/without:NO_FILE/);
  const secretAttach=await raw("spawn",{cwd:dir,prompt:"x",tools:["codemode"],coordinator:{attachments:[join(dir,".env")],tasks:[{prompt:"ATTACH_CHILD",tools:[]}]}});
  assert.equal(secretAttach.isError,true,"a secret attachment is refused like on spawn_batch");

  // A wait started alongside a dispatch in the same script covers the children being started.
  await call("spawn", {cwd:dir,id:"parallel-boss",prompt:"PARALLEL_COORDINATOR",tools:["codemode"],maxTurns:4,
    coordinator:{tasks:[{prompt:"CHILD_TARGET",label:"p1",tools:[],maxTurns:1},{prompt:"CHILD_TARGET",label:"p2",tools:[],maxTurns:1}]} });
  const parallelBoss=await settle("parallel-boss");
  assert.equal(parallelBoss.state,"done",parallelBoss.error);
  assert.match(parallelBoss.lastText,/\\"started\\":2,\\"waited\\":2/);

  await call("spawn", {cwd:dir,id:"target-boss",prompt:"TARGET_COORDINATOR",tools:["codemode"],maxTurns:6,
    coordinator:{saveDir:join(dir,"target-reports"),forkFrom:"facts",tasks:[{prompt:"CHILD_TARGET",label:"target",tools:[],maxTurns:1}]} });
  const targetBoss=await settle("target-boss");
  assert.equal(targetBoss.state,"done",targetBoss.error);
  const targetFull=await call("status",{sessionId:"target-boss",verbose:true});
  const getReports=targetReports;
  assert.equal(getReports.length,2);
  const [original,updated]=getReports;
  assert.equal(original.remainingTurns,0);
  assert.equal(original.canFollowUp,false);
  assert.equal(original.nextAction,"finish");
  assert.equal(updated.canFollowUp,true);
  assert.equal(updated.remainingTurns,1);
  assert.equal(updated.sessionId,original.sessionId,"follow-up continues the same child");
  assert.notEqual(updated.savedTo,original.savedTo,"second report does not overwrite the first");
  assert.match(await readFile(original.savedTo,"utf8"),/INITIAL ALPHA/);
  assert.match(await readFile(updated.savedTo,"utf8"),/VERIFIED FOLLOW-UP ALPHA/);
  const ordinary=await call("status",{sessionId:updated.sessionId,verbose:true});
  assert.equal(ordinary.turns,2,"MCP and coordinator share cumulative state");
  assert.equal(ordinary.toolCallCount,0);
  assert.deepEqual(ordinary.activeTools,[],"follow-up does not escalate child grants");
  assert.ok(targetFull.toolCalls.some(t=>t.name==="delegate_follow_up"&&t.state==="ok"));

  await call("spawn", { cwd: dir, id: "recovery-boss", prompt: "RECEIPT_RECOVERY", tools: ["codemode"], maxTurns: 6,
    coordinator: { saveDir: join(dir, "receipt-reports"), forkFrom: "facts", tasks: [{ prompt: "CHILD_RECEIPT", label: "receipt", tools: [], maxTurns: 1 }] } });
  const recoveryBoss = await settle("recovery-boss");
  assert.equal(recoveryBoss.state, "done", recoveryBoss.error);
  assert.match(recoveryBoss.lastText, /RECEIPT RECOVERY OK/);
  const recoveryFull = await call("status", { sessionId: "recovery-boss", verbose: true });
  assert.ok(recoveryFull.toolCalls.some((t) => t.name === "codemode" && t.state === "error"), "failed codemode exists");
  assert.ok(recoveryFull.toolCalls.some((t) => t.name === "delegate_wait" && t.state === "error" && JSON.parse(t.args).timeoutMs === 120000), "failed delegate_wait exists");
  assert.ok(recoveryFull.toolCalls.some((t) => t.name === "delegate_wait" && t.state === "ok" && JSON.parse(t.args).timeoutMs === 0), "wait(0) succeeded");
  const okCodemode = recoveryFull.toolCalls.find((t) => t.name === "codemode" && t.state === "ok");
  assert.ok(okCodemode, "second codemode succeeded");
  assert.match(okCodemode.result, /"storeDiscarded":\s*true/);
  assert.match(okCodemode.result, /"started":\s*0/);
  assert.match(okCodemode.result, /"sameId":\s*true/);
  const receiptSessions = (await call("sessions", {})).sessions.filter((s) => s.label === "receipt");
  assert.equal(receiptSessions.length, 1, "only 1 child session for receipt task");
  const receiptChild = await call("status", { sessionId: receiptSessions[0].sessionId, verbose: true });
  assert.equal(receiptChild.state, "done");
  assert.match(await readFile(receiptChild.savedTo, "utf8"), /RECEIPT REPORT ALPHA/);

  for (const args of [
    { durable: true, tools: ["codemode"], coordinator },
    { tools: ["read"], coordinator },
    { tools: ["codemode"], coordinator: { tasks: [{ prompt: "x", tools: ["write"] }] } },
    { tools: ["codemode"], coordinator: { tasks: [{ prompt: "x", coordinator }] } },
  ]) assert.equal((await raw("spawn", { cwd: dir, prompt: "x", ...args })).isError, true);
  await call("spawn", { cwd: dir, id: "plain", prompt: "NO_COORD", tools: ["codemode"], maxTurns: 3 });
  assert.match((await settle("plain")).lastText, /UNAVAILABLE/);
  await call("spawn", { cwd: dir, id: "overflow", prompt: "OVERFLOW", tools: ["codemode"], maxTurns: 3,
    coordinator: { tasks: Array.from({ length: 4 }, () => ({ prompt: "CHILD", tools: [] })) } });
  assert.match((await settle("overflow")).lastText, /concurrent/i, "coordinator occupies the fourth slot");
  assert.equal((await call("sessions", {})).sessions.filter((s) => ["a", "failure"].includes(s.label)).length, 2);

  await call("spawn", { cwd: dir, id: "web-boss", prompt: "COORDINATOR", tools: ["codemode"], maxTurns: 6,
    coordinator: { research: true, forkFrom: "facts", tasks: [
      { prompt: "CHILD_WEB", label: "web", tools: [], maxTurns: 5 },
      { prompt: "CHILD_OFF", label: "offline", research: false, tools: [], maxTurns: 2 },
    ] } });
  assert.match((await settle("web-boss")).lastText, /FETCH OFFICIAL EVIDENCE/);
  const webSessions = (await call("sessions", {})).sessions.filter((s) => ["web", "offline"].includes(s.label));
  for (const s of webSessions) {
    const state = await call("status", { sessionId: s.sessionId, verbose: true });
    if (s.label === "web") {
      assert.ok(state.toolCalls.some((t) => t.name === "mcp__exa__web_search_exa" && t.state === "ok"));
      assert.ok(state.toolCalls.some((t) => t.name === "mcp__exa__web_fetch_exa" && t.state === "ok"));
    } else assert.equal(state.toolCallCount, 0, "task research:false overrides plan research:true");
  }

  await call("spawn",{cwd:dir,id:"privileged-facts",prompt:"FACT",tools:["read","write","mcp__browser__agent_browser_fill"],nativeMcp:true,mcpServers:["browser"],maxTurns:3});
  assert.equal((await settle("privileged-facts")).state,"done");
  await call("spawn", {cwd:dir,id:"member-boss",maxTurns:6,coordinator:{forkFrom:"privileged-facts",saveDir:join(dir,"member-reports"),tasks:[
    {prompt:"CHILD_MCP_GITHUB",label:"member-github",mcpServers:["github"],tools:["mcp__github__get_file_contents"],maxTurns:3},
    {prompt:"CHILD_MCP_SERENA",label:"member-serena",mcpServers:["serena"],tools:["mcp__serena__find_symbol"],maxTurns:3},
    {prompt:"CHILD_MCP_BROWSER",label:"member-browser",mcpServers:["browser"],tools:["mcp__browser__agent_browser_snapshot"],maxTurns:3},
  ]}});
  const memberBoss=await settle("member-boss");
  assert.equal(memberBoss.state,"done",memberBoss.error);
  assert.match(memberBoss.lastText,/MEMBER EVIDENCE get_file_contents/);
  assert.match(memberBoss.lastText,/MEMBER EVIDENCE find_symbol/);
  assert.match(memberBoss.lastText,/MEMBER EVIDENCE agent_browser_snapshot/);
  const memberSessions=(await call("sessions",{})).sessions.filter(s=>s.label?.startsWith("member-"));
  assert.equal(memberSessions.length,3);
  for(const member of memberSessions){
    const state=await call("status",{sessionId:member.sessionId,verbose:true});
    assert.equal(state.forkedFrom,"privileged-facts");
    assert.equal(state.activeTools.length,1,"fork does not widen permissions");
    assert.ok(state.toolCalls.some(t=>t.name===state.activeTools[0]&&t.state==="ok"));
    await call("follow_up",{sessionId:member.sessionId,prompt:`CHILD_MCP_${member.label.split("-")[1].toUpperCase()}`,maxTurns:3});
    const followed=await settle(member.sessionId);
    assert.equal(followed.state,"done",`follow-up keeps exact MCP grants: ${JSON.stringify(followed)}`);
  }
  // Even a host-approved form tool is outside this read-only team feature.
  assert.equal((await raw("spawn",{cwd:dir,coordinator:{tasks:[{prompt:"no",mcpServers:["browser"],tools:["mcp__browser__agent_browser_fill"]}]}})).isError,true);
  console.log("  OK -> team members use selected GitHub/Serena/browser MCP tools; forks/follow-ups keep exact grants");

  await call("spawn", { cwd: dir, id: "cancel-boss", prompt: "CANCEL_PARENT", tools: ["codemode"], maxTurns: 5,
    coordinator: { tasks: [{ prompt: "SLOW_CHILD", label: "slow", tools: [], maxDurationMs: 60000 }] } });
  let slow;
  for (let n = 0; n < 100; n++) {
    slow = (await call("sessions", {})).sessions.find((s) => s.label === "slow");
    if (slow?.state === "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(slow.state, "running");
  await call("abort", { sessionId: "cancel-boss" });
  assert.equal((await call("status", { sessionId: slow.sessionId })).state, "running", "cancellation is observational, not cascading");
  await call("abort", { sessionId: slow.sessionId });
  console.log("  OK -> codemode coordinator: shared core state, fork evidence, compact waits/full stored reports, failed-script receipt recovery, capacity and cancellation");
} finally {
  await client.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => http.close(r));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
