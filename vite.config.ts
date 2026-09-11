import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build:
    mode === "standalone"
      ? {
          cssCodeSplit: false,
          rollupOptions: {
            output: {
              format: "iife",
            },
          },
        }
      : undefined,
}));
