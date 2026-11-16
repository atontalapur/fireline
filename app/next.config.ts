import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native bindings; load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
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
