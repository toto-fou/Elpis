// SPDX-License-Identifier: MIT
// test/aides/garde_boucle.mjs — préchargé (--import) par le service des essais d'intégration seulement : url_guard.js y laisse passer 127.0.0.1.
import { register } from 'node:module';

register('./garde_boucle_crochets.mjs', import.meta.url);
