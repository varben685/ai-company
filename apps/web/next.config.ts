import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@company/contracts"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:3001/:path*" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};
export default config;
