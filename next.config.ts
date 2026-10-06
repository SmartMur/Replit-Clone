import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['esbuild', '@tailwindcss/node', 'tailwindcss', '@tailwindcss/oxide', 'lightningcss'],
  // Hosts allowed to load the dev server (set ALLOWED_DEV_ORIGINS=ip1,ip2 in .env.local when using it from another device).
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'replit.com',
        pathname: '/cdn-cgi/image/**',
      },
    ],
  },
};

export default nextConfig;
