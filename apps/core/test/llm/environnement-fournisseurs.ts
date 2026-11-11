// SPDX-License-Identifier: MIT
/** apps/core/test/llm/environnement-fournisseurs.ts — à importer en premier : environnement du moteur, secret de session des vecteurs, base hors du dépôt. */
import path from "node:path";

import { DOSSIER_MOTEUR } from "../moteur-environnement";

/** Secret d'instance des vecteurs Python (identifiants de session des flux reprenables). */
export const SECRET_VECTEURS = "secret-de-vecteurs-0123456789abcdef";

process.env["APP_SESSION_SECRET"] = SECRET_VECTEURS;
process.env["APP_DB_PATH"] = path.join(DOSSIER_MOTEUR, "user_db", "app.db");
for (const nom of ["SSL_CERT_FILE", "SSL_CERT_DIR", "LLAMA_N_CTX_PER_SLOT", "LLM_REMOTE_N_CTX"])
  delete process.env[nom];

export { DOSSIER_MOTEUR };
