// The heat project lives in cache/heat/tiles (pnpm heat:tiles and pnpm match)
// and is deployed on its own with pnpm heat:pages (PLAN.md, heat). The built
// site fetches it from there; dev serves the local copy at /heat/, so heat
// works without a deploy. A build never contains it.

import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

const HEAT_DIR = resolve(import.meta.dirname, "../cache/heat/tiles");
const TYPES: Record<string, string> = { ".png": "image/png", ".json": "application/json" };

function heatTiles(): Plugin {
  return {
    name: "nyvei-heat-tiles",
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
  };
}

export default defineConfig({ plugins: [heatTiles()] });
