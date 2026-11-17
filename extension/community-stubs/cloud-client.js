export function normalizeCloudBaseUrl() {
  return "";
}

export function createCloudClient() {
  return async function unavailable() {
    throw new Error("Premium cloud client is not available in community build");
  };
}

export async function cloudAuthRequest() {
  throw new Error("Premium cloud auth is not available in community build");
}
