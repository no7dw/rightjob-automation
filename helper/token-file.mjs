import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";

export function loadLocalToken(path, override = process.env.JSEEKER_TOKEN) {
  if (override) return override;
  let file;
  try {
    file = openSync(path, "r+");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Publish only a complete credential. Concurrent starters reuse the winner
    // instead of observing an empty file or appending a second random token.
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${randomBytes(24).toString("hex")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        linkSync(temporary, path);
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
    } finally {
      unlinkSync(temporary);
    }
    file = openSync(path, "r+");
  }
  try {
    fchmodSync(file, 0o600);
    const contents = readFileSync(file, "utf8");
    const existing = contents.trim();
    if (existing) {
      // A final newline prevents zsh from displaying its trailing "%" marker.
      // Keep the token itself unchanged so paired extensions remain authorized.
      if (!contents.endsWith("\n")) writeFileSync(file, "\n");
      return existing;
    }
    const token = randomBytes(24).toString("hex");
    ftruncateSync(file, 0);
    writeSync(file, `${token}\n`, 0, "utf8");
    return token;
  } finally {
    closeSync(file);
  }
}
