import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    return {
      // Firefox/Mullvad only support spanning / not_allowed. split is Chrome-only.
      // Mullvad is effectively always private-window, so spanning is required.
      incognito: 'spanning',
      name: 'OpenAI Plus VXT',
      description: 'ChatGPT registration assistant extension',
      version: '0.0.37',
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        96: 'icon/96.png',
        128: 'icon/128.png',
      },
      action: {
        default_title: 'OpenAI Plus VXT',
        default_icon: {
          16: 'icon/16.png',
          32: 'icon/32.png',
          48: 'icon/48.png',
          96: 'icon/96.png',
          128: 'icon/128.png',
        },
      },
      permissions: [
        'storage',
        'tabs',
        'scripting',
        'cookies',
        'browsingData',
        'proxy',
        'webRequest',
        'webRequestAuthProvider',
        'alarms',
        'notifications',
        ...(!isFirefox ? ['debugger' as const] : []),
      ],
      host_permissions: [
        'http://*/*',
        'https://*/*',
        'http://127.0.0.1:8787/*',
        'http://localhost:8787/*',
        'https://auth.openai.com/*',
        'https://chatgpt.com/*',
        'https://pay.openai.com/*',
        'https://js.stripe.com/*',
        'https://www.paypal.com/*',
        'https://paypal.com/*',
        'https://www.meiguodizhi.com/*',
        'https://api.github.com/*',
        'https://mail-api.yuecheng.shop/*',
        'https://smsbower.page/*',
        'https://hero-sms.com/*',
        'https://api.smspool.net/*',
        'https://smspool.net/*',
        'https://api.tiger-sms.com/*',
        'https://foxsms.cc/*',
        'https://mail.acica.top/*',
      ],
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'openai-plus-vxt@local.opx',
                strict_min_version: '126.0',
                data_collection_permissions: {
                  required: ['none'],
                },
              },
            },
          }
        : {}),
    };
  },
});
