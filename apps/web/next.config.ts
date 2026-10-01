import type { NextConfig } from "next";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // E2E 테스트용 dev 서버를 일반 dev 서버와 동시에 띄울 수 있도록 빌드 폴더를 바꿀 수 있게 한다(기본 .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // msw/browser 는 exports 에서 "node" 조건이 막혀 있어 SSR 번들 해석이 실패한다.
  // 실제로는 브라우저에서만 실행되므로 파일 경로로 직접 연결한다.
  turbopack: {
    resolveAlias: { "msw/browser": "./node_modules/msw/lib/browser/index.js" },
  },
  // 동일 오리진 프록시: 브라우저는 /api, /files 만 호출하고 서버가 API로 전달한다(CORS 불필요).
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/files/:path*", destination: `${apiOrigin}/files/:path*` },
    ];
  },
};

export default nextConfig;
