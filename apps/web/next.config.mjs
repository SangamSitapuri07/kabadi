/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@kabadi/shared"],
  async rewrites() {
    const internalApi = process.env.INTERNAL_API_URL || "http://127.0.0.1:4000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${internalApi}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
