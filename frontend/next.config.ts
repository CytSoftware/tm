import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  // The collaborative wiki editor opens a Yjs connection with a unique client
  // id on mount. React StrictMode's dev-only double-mount spins up a second,
  // throwaway connection whose cursor lingers as a frozen "ghost" of yourself
  // until awareness times out. Disable the dev double-invoke. (No effect in
  // production builds, which never double-invoke.)
  reactStrictMode: false,
};

export default nextConfig;
