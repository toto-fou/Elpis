// elpis-remote — shim de migration vers elpis-remote.ts (le plugin est
// SPDX-License-Identifier: MIT
// désormais du TypeScript, chargé nativement par opencode/Bun).
// Ce fichier est servi à /api/code/plugin.js UNIQUEMENT pour le chemin
// « /remote update » des anciens plugins (.js, ≤ v8), qui télécharge cette URL
// et écrase ~/.config/opencode/plugin/elpis-remote.js. Au démarrage suivant :
//   1. il installe elpis-remote.ts (téléchargé depuis l'app, marqueurs vérifiés),
//   2. délègue TOUT au plugin TS (importé dynamiquement — actif immédiatement),
//   3. s'efface (elpis-remote.js supprimé) — au prochain run, seul le .ts charge.
// Les NOUVELLES installations n'en passent jamais par ici : install.sh pose
// directement le .ts. Doit rester du JS pur (les vieux plugins l'écrivent en .js).
const PLUGIN_VERSION = 15;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_DEFAULT = "__APP_URL__";
const CFG_DIR = path.join(os.homedir(), ".config", "opencode");
const CONF_PATH = path.join(CFG_DIR, "elpis-remote.json");
const PLUGIN_DIR = path.join(CFG_DIR, "plugin");
const TS_PATH = path.join(PLUGIN_DIR, "elpis-remote.ts");
const JS_PATH = path.join(PLUGIN_DIR, "elpis-remote.js");

const loadConf = () => { try { return JSON.parse(fs.readFileSync(CONF_PATH, "utf8")) || {}; } catch { return {}; } };
// Read-modify-write + rename, comme le plugin TS : plusieurs opencode partagent
// ce fichier, écrire un objet en mémoire écraserait ce qu'un voisin vient d'y
// poser (jeton appairé, état d'un autre projet).
const mutateConf = (fn) => {
  const fresh = loadConf();
  try { fn(fresh); } catch { /* best-effort */ }
  const tmp = CONF_PATH + "." + process.pid + ".tmp";
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2));
    fs.renameSync(tmp, CONF_PATH);
  } catch { try { fs.rmSync(tmp); } catch { /* absent */ } }
};
const rmQuiet = (p) => { try { fs.rmSync(p); } catch { /* absent */ } };

// fetch avec gestion du https LAN (cert auto-signé Caddy) : CA épinglée si
// l'installeur l'a posée, sinon retry non-vérifié mémorisé (option `tls` Bun).
const fetchApp = async (conf, route) => {
  const base = (conf.app_url || APP_DEFAULT).replace(/\/+$/, "");
  const url = base + route;
  if (!base.startsWith("https://")) return fetch(url);
  let ca = null;
  try { if (conf.ca_file) ca = fs.readFileSync(conf.ca_file, "utf8"); } catch { ca = null; }
  if (ca) return fetch(url, { tls: { ca } });
  if (conf.insecure) return fetch(url, { tls: { rejectUnauthorized: false } });
  try { return await fetch(url); }
  catch {
    const r = await fetch(url, { tls: { rejectUnauthorized: false } });
    conf.insecure = true;
    mutateConf((c) => { c.insecure = true; });
    return r;
  }
};

export const ElpisRemote = async (ctx) => {
  const toast = (message, variant) => {
    try { ctx.client.tui.showToast({ body: { title: "Elpis Remote", message, variant, duration: 6000 } }).catch(() => {}); } catch { /* serve */ }
  };
  const tsAlreadyThere = fs.existsSync(TS_PATH);
  try {
    if (!tsAlreadyThere) {
      const conf = loadConf();
      const r = await fetchApp(conf, "/api/code/plugin.ts");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const src = await r.text();
      // mêmes garde-fous que /remote update : jamais écrire autre chose qu'un
      // plugin elpis-remote reconnaissable (proxy captif, page d'erreur…)
      if (!src.startsWith("// elpis-remote") || !/const PLUGIN_VERSION = \d+/.test(src)) {
        throw new Error("réponse inattendue de l'app");
      }
      fs.mkdirSync(PLUGIN_DIR, { recursive: true });
      fs.writeFileSync(TS_PATH, src);
    }
    if (tsAlreadyThere) {
      // opencode a DÉJÀ chargé le .ts dans ce process (glob *.{ts,js}) : ne pas
      // créer une 2e instance — on se contente de s'effacer pour le prochain run.
      rmQuiet(JS_PATH); rmQuiet(JS_PATH + ".bak");
      return {};
    }
    const mod = await import(pathToFileURL(TS_PATH).href);
    const impl = await (mod.ElpisRemote || mod.default)(ctx);
    // le .ts est en place et actif — le shim peut disparaître
    rmQuiet(JS_PATH); rmQuiet(JS_PATH + ".bak");
    toast("Plugin elpis-remote migré en TypeScript (v" + PLUGIN_VERSION + ").", "success");
    return impl;
  } catch (e) {
    // app injoignable / réponse invalide : on reste en place pour retenter au
    // prochain démarrage — plugin inerte sur ce run.
    toast("Migration du plugin impossible (" + (e && e.message ? e.message : "erreur") + ") — relancez l'installeur OpenCode.", "warning");
    return {};
  }
};
export default ElpisRemote;
