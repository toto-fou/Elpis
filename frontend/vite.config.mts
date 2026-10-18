// SPDX-License-Identifier: MIT
/** frontend/vite.config.mts — build des entrées (chat, console, diagnostic de démarrage) dans frontend/dist, manifeste lu par apps/core/src/interface/pages.ts. */
import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

import { vendorElpis } from "./vendor.config.mts";

const ICI = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: ICI,
  base: "./",
  publicDir: false,
  plugins: [vue(), vendorElpis()],
  resolve: {
    // Build runtime : tous les gabarits sont des SFC compilés au build (frontend/test/build/sans-compilateur.test.ts).
    alias: [{ find: /^vue$/, replacement: "vue/dist/vue.runtime.esm-bundler.js" }],
  },
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: "es2022",
    rolldownOptions: {
      input: {
        diagnostic: fileURLToPath(new URL("src/entries/diagnostic.ts", import.meta.url)),
        main: fileURLToPath(new URL("src/entries/main.ts", import.meta.url)),
        admin: fileURLToPath(new URL("src/entries/admin.ts", import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [{ name: "socle", test: /node_modules[\\/](?:vue|@vue|marked|dompurify)[\\/]/ }],
        },
      },
    },
  },
});
