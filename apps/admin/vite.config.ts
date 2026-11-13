import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  resolve: { conditions: ["@event-manager/source", ...defaultClientConditions] },
  server: { port: 5173 },
});
