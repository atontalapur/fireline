import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native bindings; load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // duckdb.node loads libduckdb.so at runtime, which file tracing does not follow.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@duckdb/node-bindings-linux-x64/libduckdb.so"],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
