export function normalizeBaseUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

export function openAICompatibleProviders(catalog) {
  return Array.isArray(catalog?.providers)
    ? catalog.providers
        .filter(
          (provider) =>
            ["openai_chat", "openai_responses", "anthropic_messages"].includes(
              provider?.protocol,
            ) &&
            typeof provider.id === "string" &&
            typeof provider.name === "string" &&
            normalizeBaseUrl(provider.baseUrl),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
}

export function catalogProviderById(catalog, providerId) {
  return (
    openAICompatibleProviders(catalog).find(
      (provider) => provider.id === providerId,
    ) || null
  );
}

export function matchCatalogProvider(catalog, baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return null;
  const providers = openAICompatibleProviders(catalog);
  const exact = providers.find(
    (provider) => normalizeBaseUrl(provider.baseUrl) === normalized,
  );
  if (exact) return exact;
  let matchedHost = "";
  let matched = null;
  for (const provider of providers) {
    const candidates = [
      provider.baseUrl,
      ...(provider.endpointCandidates || []),
    ]
      .map(normalizeBaseUrl)
      .filter(Boolean);
    for (const candidate of candidates) {
      try {
        const target = new URL(normalized);
        const source = new URL(candidate);
        if (
          source.host === target.host &&
          (target.pathname.startsWith(source.pathname) ||
            source.pathname.startsWith(target.pathname)) &&
          source.host.length > matchedHost.length
        ) {
          matchedHost = source.host;
          matched = provider;
        }
      } catch {}
    }
  }
  return matched;
}

export function providerModels(provider) {
  return Array.isArray(provider?.models)
    ? provider.models.filter(
        (model) => typeof model?.id === "string" && model.id.trim(),
      )
    : [];
}

export function defaultProviderModel(provider) {
  const models = providerModels(provider);
  return (
    models.find((model) => /flash|lite|mini|fast/i.test(model.id))?.id ||
    models[0]?.id ||
    ""
  );
}
