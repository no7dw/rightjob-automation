// Inlined at build time by scripts/build.mjs (esbuild define).
export const PAY_MODE = process.env.JSEEKER_PAY_MODE === "1";
export const CLOUD_BASE_URL = process.env.JSEEKER_CLOUD_BASE_URL || "";
export const DEFAULT_LLM_MODE = PAY_MODE ? "hosted" : "byok";
