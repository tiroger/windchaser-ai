import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // PR chances and still-air records moved to the wind page's Segments
      // mode; old links and bookmarks land there.
      { source: "/training/segments", destination: "/?mode=segments", permanent: true },
    ];
  },
};

export default nextConfig;
