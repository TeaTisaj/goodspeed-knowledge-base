import type { NextConfig } from 'next';

const config: NextConfig = {
  // Shared workspace packages ship compiled JS, so no transpilePackages needed.
  reactStrictMode: true,
};

export default config;
