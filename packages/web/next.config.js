/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@vi/core"],
  turbopack: {
    resolveAlias: {
      "@vi/core": "../core/dist/index.js",
    },
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
