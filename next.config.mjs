/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // socket.io-client / cookie / pg pull in a few Node built-ins that only
  // matter for the standalone realtime/socket-server.ts process, not the
  // Next.js server itself — nothing to externalize here as of Next 14 with
  // the App Router's default server component bundling.
};

export default nextConfig;
