export function isPayEdition() {
  return false;
}

export function createPaySettings() {
  return {
    enabled: false,
    async boot() {},
    apply() {},
    dispose() {},
  };
}
