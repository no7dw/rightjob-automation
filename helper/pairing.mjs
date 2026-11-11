import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// Chromium derives unpacked extension IDs from their absolute directory path.
export function unpackedExtensionId(directory) {
  let path = resolve(directory);
  try {
    path = realpathSync(path);
  } catch {
    // dist may not exist yet when the Helper starts before the first build.
  }
  return [...createHash("sha256").update(path).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

export function pairingOriginAllowed(origin, projectRoot) {
  return ["dist", "extension"].some(
    (directory) =>
      origin ===
      `chrome-extension://${unpackedExtensionId(resolve(projectRoot, directory))}`,
  );
}
