import { installSavedPaymentStripePageBridge } from '../src/features/saved-payment-methods/stripe-element-page';

const PAGE_BRIDGE_KEY = '__opx_saved_payment_page_bridge_v1__';

export default defineContentScript({
  matches: [
    'https://chatgpt.com/*',
    'http://localhost:1455/*',
    'http://127.0.0.1:1455/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const scope = globalThis as typeof globalThis & { [PAGE_BRIDGE_KEY]?: () => void };
    if (scope[PAGE_BRIDGE_KEY]) return;
    scope[PAGE_BRIDGE_KEY] = installSavedPaymentStripePageBridge();
  },
});
