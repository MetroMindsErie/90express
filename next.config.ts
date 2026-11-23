import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep the dev server's build output away from `next build`'s.
   *
   * Both default to `.next`. Running a production build while a dev server is
   * up overwrites the chunks the dev server is serving, and the dev server
   * then throws module-not-found errors that look like application bugs but
   * are not. The dev script sets NEXT_DIST_DIR so the two never collide.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
