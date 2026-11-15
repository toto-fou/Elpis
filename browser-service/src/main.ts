// SPDX-License-Identifier: MIT
/** browser-service/src/main.ts — point d'entrée du service navigateur (`node dist/main.mjs`), lancé par l'hôte d'outils dans le bac d'un compte : socket Unix et jeton d'appel exigés, relais filtrant, routes enregistrées dans leur ordre historique. */
import express from "express";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";

import { creerContexte } from "./contexte.ts";
import { demarrerRelais } from "./proxy_guard.ts";
import { BASE_DIR, creerDossiers, TRACE_DIR, VIDEO_DIR } from "./reglages.ts";
import { nettoyerSortie, normaliserErreur } from "./result_util.ts";
import { registerActionRoutes } from "./routes/action.ts";
import { registerAdminRoutes } from "./routes/administration.ts";
import { registerChainRoutes } from "./routes/chaine.ts";
import { registerLoginRoutes } from "./routes/connexion.ts";
import { registerStartRoutes } from "./routes/demarrage.ts";
import { registerMiscRoutes } from "./routes/divers.ts";
import { registerRecorderRoutes } from "./routes/enregistreur.ts";
import { registerInspectRoutes } from "./routes/inspection.ts";
import { registerLocatorRoutes } from "./routes/localiser.ts";
import { registerObserveRoutes } from "./routes/observation.ts";
import { registerTabRoutes } from "./routes/onglets.ts";
import { registerPageRoutes } from "./routes/page.ts";
import { registerMockRoutes } from "./routes/simulations.ts";
import {
  demarrerNettoyages,
  gracefulShutdown,
  MAX_SESSIONS_PER_GROUP,
  MAX_SESSIONS_PER_OWNER,
} from "./sessions.ts";
import { gardeJeton } from "./service_auth.ts";
import { verifierBac } from "./url_guard.ts";

// Service lancé par l'hôte d'outils dans le bac d'un compte : socket unix (FIREFOX_SERVICE_SOCKET) et jeton du bac
// (BROWSER_SERVICE_TOKEN) exigés ; boucle locale du bac jointe directement, tout le reste par le relais de l'hôte
// (BROWSER_RELAY_SOCKET), qui juge les destinations et injecte les secrets.
const LISTEN_SOCKET = (process.env.FIREFOX_SERVICE_SOCKET || "").trim();
const JETON = (process.env.BROWSER_SERVICE_TOKEN || "").trim();
for (const [manque, nom] of [
  [!LISTEN_SOCKET, "FIREFOX_SERVICE_SOCKET (its Unix socket)"],
  [!JETON, "BROWSER_SERVICE_TOKEN (its call token)"],
] as const) {
  if (!manque) continue;
  console.error(
    `[browser-service] ${nom} is required: the browser service only runs inside an account's sandbox, started by the tool host.`,
  );
  process.exit(1);
}
// Appels acceptés par seconde, tous confondus (PW_RATE_MAX_PER_S).
const DEBIT_MAX_PAR_S = Math.max(1, parseInt(process.env.PW_RATE_MAX_PER_S || "300", 10) || 300);
// Arrêt du service après tant de secondes sans appel (0 = jamais).
const ARRET_INACTIF_MS = Math.max(0, parseInt(process.env.BROWSER_IDLE_EXIT_S || "0", 10) || 0) * 1000;
let _dernierAppel = Date.now();

const app = express();
// Débit des appels borné avant tout (jeton compris) : un seul appelant, l'hôte d'outils, donc une seule clé ; une boucle folle reçoit 429 au lieu de saturer le service.
app.use(
  rateLimit({
    windowMs: 1000,
    limit: DEBIT_MAX_PAR_S,
    keyGenerator: () => "tool-host",
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many calls to the browser service: retry in a moment.",
        code: "rate_limited",
        retryable: true,
      });
    },
  }),
);
// Jeton d'appel vérifié avant le reste, statiques compris.
app.use(gardeJeton(JETON));
app.use((_req, _res, next) => {
  _dernierAppel = Date.now();
  next();
});
app.use(express.json({ limit: "50mb" }));
// Express 5 laisse req.body indéfini sans corps JSON : les routes le lisent comme un objet, comme sous Express 4.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});

// ── Captures servies en statique (sans cache). Pas d'en-tête CORS : seul le
// backend d'Elpis les relit, de serveur à serveur.
app.use(
  "/screenshots",
  (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
  },
  express.static(path.join(BASE_DIR, "screenshots")),
);

creerDossiers();

// Toute réponse JSON : erreurs avec un code stable ; messages et chemins sans séquences ANSI (contenu de la page intact).
app.use((req, res, next) => {
  req.recuA = Date.now();
  const json = res.json.bind(res);
  res.json = (corps?: unknown) => json(nettoyerSortie(normaliserErreur(corps, res.statusCode)));
  next();
});

// ── Serve videos & traces statically (Phase 5) — registered after the dirs
//    are defined (VIDEO_DIR/TRACE_DIR consts) to avoid a TDZ at module load.
app.use("/videos", express.static(VIDEO_DIR));
app.use("/traces", express.static(TRACE_DIR));

// ════════════════════════════════════════════════════════════════════
//  DESTINATIONS (cf. url_guard.js, proxy_guard.js)
// ════════════════════════════════════════════════════════════════════
//  Le relais filtrant (proxy_guard.js) fait foi : TOUT le trafic du
//  navigateur y passe (navigations, redirections, sous-ressources, WebSocket,
//  service workers) ; la boucle locale du bac y est jointe directement, le
//  reste part au relais de l'hôte, qui juge la destination (profil réseau du
//  bac, politique du navigateur). Avant une navigation demandée (goto, nouvel
//  onglet, /start), seule la forme de l'adresse est contrôlée ici.

const _relais = await demarrerRelais({
  verifier: verifierBac(),
  amont: {
    socket: process.env.BROWSER_RELAY_SOCKET || "/run/elpis/browser-relay.sock",
    jeton: process.env.BROWSER_RELAY_TOKEN || "",
  },
  journal: (m) => console.warn(`[GARDE] ${m}`),
});
console.log(`[GARDE] relais filtrant sur 127.0.0.1:${_relais.port}`);
const ctx = creerContexte(_relais.port);

demarrerNettoyages(ctx);
process.on("SIGTERM", () => {
  void gracefulShutdown(ctx, "SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown(ctx, "SIGINT");
});
process.on("uncaughtException", (e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : e);
  // Arrêt borné : une fermeture de session gelée ne doit pas empêcher la
  // sortie (et donc la relance).
  setTimeout(() => process.exit(1), 15000).unref();
  void gracefulShutdown(ctx, "uncaughtException", 1);
});
// Une promesse rejetée sans gestionnaire (souvent une page fermée pendant
// une attente Playwright) est journalisée : elle ne doit ni passer inaperçue
// ni arrêter le service pour toutes les sessions.
process.on("unhandledRejection", (raison) => {
  console.error("[UNHANDLED]", raison && (raison as Error).stack ? (raison as Error).stack : raison);
});

// Routes, dans l'ordre historique de leur enregistrement.
registerStartRoutes(app, ctx);
registerLoginRoutes(app, ctx);
registerActionRoutes(app, ctx);
registerLocatorRoutes(app, ctx);
registerInspectRoutes(app, ctx);
registerPageRoutes(app, ctx);
registerTabRoutes(app, ctx);
registerMiscRoutes(app, ctx);
registerChainRoutes(app, ctx);
registerAdminRoutes(app, ctx);
registerObserveRoutes(app, ctx);
registerMockRoutes(app, ctx);
registerRecorderRoutes(app, ctx);

// Socket unix du bac (/run/elpis/browser.sock), joint par l'hôte d'outils avec le jeton du bac.
try {
  fs.unlinkSync(LISTEN_SOCKET);
} catch {
  /* absent */
}
app.listen(LISTEN_SOCKET, () => {
  try {
    fs.chmodSync(LISTEN_SOCKET, 0o666);
  } catch (e) {
    console.error("[LISTEN] chmod", (e as Error).message);
  }
  console.log(
    `🌐 Browser AGENT Server (Playwright, Chromium headless) running on ${LISTEN_SOCKET} (TTL: 15min, ${MAX_SESSIONS_PER_OWNER} sessions par propriétaire, ${MAX_SESSIONS_PER_GROUP} pour le compte, sous-agents compris)`,
  );
});
// Sans appel pendant BROWSER_IDLE_EXIT_S, le service s'arrête (l'hôte le relance au prochain outil pw_*).
if (ARRET_INACTIF_MS > 0) {
  let arret = false;
  setInterval(
    () => {
      if (!arret && Date.now() - _dernierAppel > ARRET_INACTIF_MS) {
        arret = true;
        void gracefulShutdown(ctx, "idle", 0);
      }
    },
    Math.min(30000, ARRET_INACTIF_MS),
  ).unref();
}
