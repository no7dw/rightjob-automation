/** Community no-op pay runtime for the service worker. */
export function createBackgroundPay() {
  return {
    enabled: false,
    PAY_MODE: false,
    async resolvedLlmMode() {
      return "byok";
    },
    async enhanceLocalRequest(path, body, signal, localHelperRequest) {
      return localHelperRequest(path, body, signal);
    },
    async afterContactOpened() {
      return null;
    },
    async safeHostedStatus() {
      return null;
    },
    messageHandlers: {},
    async getPayForConfig() {
      return null;
    },
  };
}
