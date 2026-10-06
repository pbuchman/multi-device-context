import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

function sourceBuild(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig(() => {
  const uiBuild = sourceBuild();
  return {
    define: { __MDC_UI_BUILD__: JSON.stringify(uiBuild) },
    plugins: [react(), {
      name: "mdc-build-metadata",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ uiBuild })}\n` });
      },
    }],
    build: {
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom"],
            "vendor-auth": ["@auth0/auth0-spa-js"],
            "vendor-firebase": ["firebase/app", "firebase/auth", "firebase/firestore", "firebase/storage"],
          },
        },
      },
      chunkSizeWarningLimit: 900,
    },
  };
});
