/**
 * Launches Next with the OS certificate store trusted, then hands off.
 *
 * Juniper talks to Google Fonts at build time and to job boards, HN, and the
 * Anthropic API at runtime. On any network doing TLS interception (most
 * corporate proxies, some VPNs) those calls fail with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE because Node ships its own root list and
 * ignores the OS one. `--use-system-ca` *adds* the system roots to Node's
 * bundled set — it does not disable verification, unlike
 * NODE_TLS_REJECT_UNAUTHORIZED=0, which you should never use here.
 *
 * Set JUNIPER_SKIP_SYSTEM_CA=1 to opt out.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = "--use-system-ca";
const existing = process.env.NODE_OPTIONS ?? "";

// The flag only exists on Node >= 22.15, and passing an unknown option is a
// hard startup failure. CI builders don't intercept TLS, so skip it there
// rather than risk breaking a deploy.
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsFlag = major > 22 || (major === 22 && minor >= 15);
const wanted =
  supportsFlag &&
  !process.env.CI &&
  !process.env.VERCEL &&
  process.env.JUNIPER_SKIP_SYSTEM_CA !== "1" &&
  !existing.includes(flag);

const env = { ...process.env };
if (wanted) env.NODE_OPTIONS = `${existing} ${flag}`.trim();

// Resolve Next's CLI entry and run it under this Node binary. Spawning the
// `next` shim through a shell would work too, but shell:true with arguments
// triggers a Node deprecation warning and needs escaping care on Windows.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...args], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
