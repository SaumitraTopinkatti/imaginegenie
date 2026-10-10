import type { E2eControl } from "./mocks/secureStore.mock";

declare global {
  interface Window {
    __e2e__?: E2eControl;
    __IMAGINEGENIE_E2E_MOCK__?: string;
  }
}

export {};
