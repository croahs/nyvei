import { defineConfig } from "vite";

// GitHub Pages serves the site under /nyvei/, which the publish workflow
// passes as NYVEI_BASE. Local dev and builds stay at /.
export default defineConfig({
  base: process.env.NYVEI_BASE ?? "/",
});
