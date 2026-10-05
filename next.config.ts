import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['esbuild'],
  allowedDevOrigins: ['192.168.45.61'],
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
