import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { profileFromCV } from "../extension/core.js";

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run import-cv -- /path/to/cv.md");
  process.exit(1);
}

const file = resolve(source);
const profile = await profileFromCV(
  await readFile(file, "utf8"),
  basename(file),
);

// Keep the real CV machine-local. Only profile.example.json is committed.
await writeFile(
  new URL("../extension/profile.local.json", import.meta.url),
  JSON.stringify(profile, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  `Profile: ${profile.name}; hash: ${profile.version.slice(0, 12)}; contacts removed; wrote extension/profile.local.json`,
);
