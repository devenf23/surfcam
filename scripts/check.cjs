const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function filesUnder(relative, extensions) {
  const result = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (extensions.has(path.extname(entry.name))) result.push(file);
    }
  };
  walk(path.join(root, relative));
  return result.sort();
}

const javascript = [
  ...filesUnder("api", new Set([".js"])),
  ...filesUnder("assets/js", new Set([".js", ".mjs"])),
  ...filesUnder("test", new Set([".cjs"])),
  ...filesUnder("scripts", new Set([".cjs"]))
];

let failed = false;
for (const file of javascript) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error || result.status !== 0) failed = true;
}

const bash = spawnSync("bash", ["-n", path.join(root, "scripts", "mobile-webkit.sh")], { stdio: "inherit" });
if (bash.error || bash.status !== 0) failed = true;
process.exitCode = failed ? 1 : 0;
