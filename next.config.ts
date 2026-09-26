import path from "node:path";

import type { NextConfig } from "next";

/**
 * `better-sqlite3` is a native addon, `pg` is a server library, and `unpdf` and
 * `mammoth` ship their own WASM/JS assets; all four must stay outside the
 * bundler. Both database drivers are imported on demand (see src/lib/db), so on
 * Vercel only `pg` is ever loaded.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "unpdf", "mammoth", "better-sqlite3"],
  eslint: {
    dirs: ["src", "tests"],
  },
  experimental: {
    // One worker, because the page-data step spawns parallel workers and this is
    // built on machines that cannot always spare the memory. It costs a little
    // build time and removes a class of "works on a big box" failure.
    cpus: 1,
    // Trades a little build time for a lower peak, which keeps the build inside
    // the memory limit of a small machine or a modest CI runner.
    webpackMemoryOptimizations: true,
  },
  // There is an unrelated lockfile in a parent directory on this machine; without
  // this, Next infers the wrong workspace root and traces the wrong tree.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
