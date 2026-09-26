import type { UdjatBridge } from './index';

declare global {
  interface Window {
    udjat: UdjatBridge;
  }
}

export {};
