import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
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
});
