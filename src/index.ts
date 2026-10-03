#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { recoverAbandoned, suspendAll } from "./registry.js";
import { createServer } from "./server.js";
import { cleanup } from "./statusline/state.js";

/** How often to check that the host that launched us is still alive. */
const HOST_WATCH_MS = 30_000;

// A misbehaving pi extension can fire a timer after its session is disposed and throw from
// outside every await. Without this the whole server dies with it.
process.on("uncaughtException", (err: unknown) => {
  process.stderr.write(`[pi-delegate] uncaught: ${(err as Error)?.stack ?? String(err)}\n`);
});
process.on("unhandledRejection", (err: unknown) => {
  process.stderr.write(`[pi-delegate] unhandled rejection: ${(err as Error)?.stack ?? String(err)}\n`);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.race([
    suspendAll(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]).catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
process.on("exit", cleanup);

// An MCP host that dies without closing the transport would otherwise leave this process
// running forever, holding sessions and a state file nobody reads.
process.stdin.on("close", () => void shutdown());
const HOST_PID = process.ppid;
setInterval(() => {
  try {
    process.kill(HOST_PID, 0);
  } catch {
    void shutdown();
  }
}, HOST_WATCH_MS).unref();

await recoverAbandoned();
await createServer().connect(new StdioServerTransport());
