import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: "Voice-to-Text",
    version: "1.0.0",
    permissions: [
      "storage",
      "activeTab"
    ],
    host_permissions: [
      "http://127.0.0.1/*",
      "http://localhost/*"
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';"
    }
  }
});
