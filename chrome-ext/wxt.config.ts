import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "web2md",
    version: "0.1.0",
    description: "网页转 Markdown，让 AI 直接读",
    permissions: [
      "tabs",
      "activeTab",
      "storage",
      "contextMenus",
      "clipboardWrite",
      "scripting",
      "alarms",
    ],
    host_permissions: ["<all_urls>"],
    options_ui: {
      page: "src/options/index.html",
      open_in_tab: true,
    },
  },
  modules: ["@wxt-dev/module-react"],
});