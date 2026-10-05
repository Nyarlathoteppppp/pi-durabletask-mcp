import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "m", version: "0" });
await c.connect(new StdioClientTransport({
  command: "pi-delegate-mcp",
  env: { ...process.env, PI_DELEGATE_MODEL: "openrouter/stealth/ox-alpha" },
}));
const call = async (n,a)=>JSON.parse((await c.callTool({name:n,arguments:a})).content[0].text);
await call("init",{});

console.log("[default - không truyền model]");
console.log("   ", (await call("run",{prompt:"Reply only: A", cwd:"/tmp", verbose:true})).model);

for (const m of ["opencode-go/deepseek-v4-flash","opencode-go/ox-alpha-free","knowns-hub/claude-fast"]) {
  const r = await call("run", { prompt: "Reply only: OK", model: m, cwd: "/tmp", verbose:true });
  console.log(`[override ${m}]\n    -> ${r.model}  state=${r.state}  text=${JSON.stringify(r.lastText)}`);
}
await c.close(); process.exit(0);
