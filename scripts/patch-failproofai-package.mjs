import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "node_modules/failproofai/package.json");

if (!existsSync(pkgPath)) {
  console.log("failproofai not installed; skip patch");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const dist = join(root, "node_modules/failproofai/dist/index.js");

if (!existsSync(dist)) {
  console.warn("failproofai dist/index.js missing; skip patch");
  process.exit(0);
}

if (pkg.main === "dist/index.js" && pkg.exports) {
  console.log("failproofai package.json already patched");
  process.exit(0);
}

pkg.main = "dist/index.js";
pkg.exports = {
  ".": {
    import: "./dist/index.js",
    require: "./dist/index.js",
    default: "./dist/index.js",
  },
};

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("patched failproofai package.json with main/exports");
