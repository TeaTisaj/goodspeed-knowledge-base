import type { NextConfig } from 'next';

const config: NextConfig = {
  // Shared workspace packages ship compiled JS, so no transpilePackages needed.
  reactStrictMode: true,
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into this directory on
  // every run. Disabled rather than gitignored, so that starting the app does
  // not leave files a reviewer has to wonder about.
  agentRules: false,
};

export default config;
