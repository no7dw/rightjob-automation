import { build } from "esbuild";
import {
  mkdir,
  copyFile,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { loadLocalToken } from "../helper/token-file.mjs";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
// A machine-local credential proves possession of this project's private
// extension resource during pairing. Never copy the Helper Token or API key.
const pairingKey = loadLocalToken(".helper-pairing-key", "");
for (const path of [
  "extension/helper-pairing.json",
  "dist/helper-pairing.json",
]) {
  await writeFile(path, JSON.stringify({ key: pairingKey }) + "\n", {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}
await build({
  entryPoints: {
    content: "extension/content.js",
    "liepin-detail": "extension/bonus-details-liepin.js",
    "boss-chat": "extension/boss-chat.js",
    "boss-bonus-detail": "extension/bonus-details-boss.js",
  },
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome116",
  loader: { ".css": "text" },
  sourcemap: false,
});
await build({
  entryPoints: ["extension/auto-reply-entry.js"],
  bundle: true,
  outfile: "dist/boss-auto-reply.js",
  format: "iife",
  target: "chrome116",
  loader: { ".css": "text" },
  sourcemap: false,
});
await build({
  entryPoints: ["extension/auto-reply-entry.js"],
  bundle: true,
  outfile: "dist/liepin-auto-read.js",
  format: "iife",
  target: "chrome116",
  loader: { ".css": "text" },
  sourcemap: false,
});
await build({
  entryPoints: [
    "extension/background.js",
    "extension/options.js",
    "extension/popup.js",
  ],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "chrome116",
});
for (const file of [
  "manifest.json",
  "options.html",
  "popup.html",
  "profile.example.json",
  "llm-provider-catalog.json",
])
  await copyFile(`extension/${file}`, `dist/${file}`);
// A real CV stays machine-local. Copy it only when it exists; never commit it.
try {
  await copyFile("extension/profile.local.json", "dist/profile.local.json");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const profile = JSON.parse(
  await readFile("dist/profile.example.json", "utf8"),
);
if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b/i.test(profile.text))
  throw new Error("Unexpected personal contact in example profile");
try {
  const env = await readFile(".env", "utf8");
  const secret = env
    .split(/\r?\n/)
    .find((line) => /^OPENAI_API_KEY=/.test(line))
    ?.slice("OPENAI_API_KEY=".length)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (secret && secret.length >= 8) {
    const files = await readdir("dist", {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      if ((await readFile(path, "utf8")).includes(secret))
        throw new Error("Build output contains the OPENAI_API_KEY value");
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log("Built unpacked extension: dist/");
