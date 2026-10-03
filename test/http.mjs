import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createSecureServer } from "node:http2";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

if (process.argv[2] === "worker") {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  // Provider extensions load npm Undici before Node's first native fetch.
  piRequire("undici").getGlobalDispatcher();
  const { getRuntime } = await import("../dist/pi/runtime.js");
  await getRuntime();
  const response = await fetch(process.argv[3]);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
  console.log("  OK -> SDK runtime decodes gzip over TLS with an npm Undici dispatcher");
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), "pi-delegate-http-"));
let server;
try {
  const certificate = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", certificate, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  server = createSecureServer({ key: await readFile(key), cert: await readFile(certificate), allowHTTP1: true });
  server.on("request", (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(gzipSync(JSON.stringify({ ok: true })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["test/http.mjs", "worker", `https://127.0.0.1:${server.address().port}/`], {
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(directory, "agent"), NODE_EXTRA_CA_CERTS: certificate },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, "compressed OAuth responses must remain readable in the SDK host");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
