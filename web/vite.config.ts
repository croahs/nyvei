// The heat overlay tiles live in cache/heat/tiles (pnpm heat:tiles), outside
// web/public, because they are derived Strava data: dev serves them at /heat/,
// and a build copies them only with PUBLISH_HEAT=1, from the environment or
// .env (PLAN.md, heat). Without them the site simply has no heat overlay.

import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

const ENV_FILE = resolve(import.meta.dirname, "../.env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const HEAT_DIR = resolve(import.meta.dirname, "../cache/heat/tiles");
const TYPES: Record<string, string> = { ".png": "image/png", ".json": "application/json" };

function heatTiles(): Plugin {
  let outDir = "";
  return {
    name: "nyvei-heat-tiles",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/heat", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!));
        const path = join(HEAT_DIR, rel);
        if (!path.startsWith(HEAT_DIR + sep) || !existsSync(path) || !statSync(path).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const type = TYPES[path.slice(path.lastIndexOf("."))];
        if (!type) return next();
        res.setHeader("Content-Type", type);
        createReadStream(path).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(HEAT_DIR)) return;
      if (process.env.PUBLISH_HEAT !== "1") {
        console.log("heat tiles left out of the build: set PUBLISH_HEAT=1 in .env to publish them (PLAN.md, heat)");
        return;
      }
      cpSync(HEAT_DIR, join(outDir, "heat"), { recursive: true });
      console.log(`heat tiles copied to ${join(outDir, "heat")}`);
    },
  };
}

export default defineConfig({ plugins: [heatTiles()] });
