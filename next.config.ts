import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the AI SDK and the libsql driver out of the bundler so their
  // streaming internals and native bindings resolve against the real runtime.
  serverExternalPackages: ["@anthropic-ai/sdk", "@libsql/client", "libsql"],
};

export default nextConfig;
