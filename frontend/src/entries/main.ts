// SPDX-License-Identifier: MIT
/** frontend/src/entries/main.ts — entrée du chat (index.html) : Zod sans évaluation (en premier), drapeaux de la page, carte vendor et worklet de la voix, puis montage de la racine précompilée. */
// En premier : les schémas construits à l'import liraient sinon `jitless` à faux et sonderaient `new Function`.
import "../platform/zod-sans-eval";

import "@highlightjs/cdn-assets/styles/github-dark.min.css";
import "../styles/racine.css";
import "../styles/chat.css";
import "../styles/rag.css";

import { createApp } from "vue";
import carteVendor from "virtual:elpis-vendor";

import { installerPageChat } from "../app/page";
import App from "../components/racine/App.vue";
import { definirUrlWorklet } from "../features/voix/micro";
import urlWorklet from "../features/voix/worklet?worker&url";
import { definirCarteVendor } from "../platform/vendor";

installerPageChat();
definirCarteVendor(carteVendor);
definirUrlWorklet(urlWorklet);
createApp(App).mount("#app");
