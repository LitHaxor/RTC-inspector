import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@rtc-inspector/core", "@rtc-inspector/sdk", "@rtc-inspector/ui"],
  reactStrictMode: true,
  devIndicators: false,
  agentRules: false,
};

export default config;
