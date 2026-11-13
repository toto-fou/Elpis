// SPDX-License-Identifier: MIT
/** tests/perf/scenarios/l_app_fluidite.mjs — fluidité de toute l'application sur le vrai cœur : chaque geste mesuré de l'entrée à la peinture qui montre la réponse puis à l'état stable, tâches longues, images lentes, décalages ; profil des gestes lents */
// Lancé par tests/frontend/app-fluidity-verify.mjs. Le catalogue des gestes est dans tests/perf/scenarios/l_app_gestes.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as bac from "../../frontend/aides-bac.mjs";
import { ARBRE_BAC, FICHIERS_BAC, poserDonnees } from "../fixtures/app_fluidity_data.mjs";
import { gestesChat, gestesConsole, gestesDemarrage } from "./l_app_gestes.mjs";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SEUILS = { instantane: 100, image: 33, tache: 50 };
const MEME = { "sec-fetch-site": "same-origin" };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sondes posées avant l'application : tâches longues, événements, décalages, mutations, entrées datées, échantillonneur lu après la peinture. */
function sondes(demarrage) {
  if (window.__ab) return;
  const ab = (window.__ab = {
    lt: [],
    ev: [],
    ls: [],
    fr: [],
    lat: [],
    att: [],
    pein: [],
    tIn: 0,
    tVis: 0,
    tFin: 0,
    lastMut: 0,
    nMut: 0,
    pVis: null,
    pFin: null,
    jalons: [],
    parImage: null,
    serie: [],
    actif: false,
    demarrage: false,
    raf: 0,
  });
  const observer = (type, f, o) => {
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) f(e);
      }).observe({ type, buffered: true, ...o });
    } catch {
      /* type non pris en charge */
    }
  };
  observer("longtask", (e) => ab.lt.push([e.startTime, e.duration]));
  observer(
    "event",
    (e) =>
      ab.ev.push([
        e.name,
        e.startTime,
        e.duration,
        e.processingEnd - e.processingStart,
        e.interactionId || 0,
      ]),
    { durationThreshold: 16 },
  );
  observer("layout-shift", (e) => ab.ls.push([e.startTime, e.value, e.hadRecentInput ? 1 : 0]));
  new MutationObserver((l) => {
    ab.lastMut = performance.now();
    ab.nMut += l.length;
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  // Entrées de l'utilisateur (déclencheurs du geste) : la première date le geste, chacune attend la peinture qui la suit.
  ab.declencheurs = new Set(["pointerdown", "keydown", "wheel", "paste", "change"]);
  for (const type of ["pointerdown", "keydown", "wheel", "paste", "change", "pointerover", "beforeinput"])
    addEventListener(
      type,
      (e) => {
        if (!ab.actif || !ab.declencheurs.has(type)) return;
        if (!ab.tIn) {
          ab.tIn = e.timeStamp;
          ab.tInEcoute = performance.now();
          console.timeStamp("ab-entree");
        }
        ab.att.push([type, e.timeStamp]);
      },
      { capture: true, passive: true },
    );
  const verifier = (p) => {
    try {
      return !!p();
    } catch {
      return false;
    }
  };
  const canal = new MessageChannel();
  canal.port1.onmessage = () => {
    const t = performance.now();
    const f = ab.fr[ab.fr.length - 1];
    if (f) f[1] = t;
    for (const [type, ts] of ab.pein) ab.lat.push([type, ts, t]);
    ab.pein = [];
    if (!ab.tIn && !ab.demarrage) return;
    if (!ab.tVis && ab.pVis && verifier(ab.pVis)) ab.tVis = t;
    if (ab.tVis && !ab.tFin && (ab.pFin ? verifier(ab.pFin) : true)) ab.tFin = t;
    for (const j of ab.jalons) if (!j[2] && verifier(j[1])) j[2] = t;
    if (ab.parImage) {
      try {
        ab.serie.push(ab.parImage());
      } catch {
        /* compteur en erreur ignoré */
      }
    }
  };
  const boucle = (ts) => {
    if (!ab.actif) {
      ab.raf = 0;
      return;
    }
    ab.fr.push([ts, 0]);
    ab.pein.push(...ab.att);
    ab.att = [];
    canal.port2.postMessage(0);
    ab.raf = requestAnimationFrame(boucle);
  };
  ab.armer = (declencheurs) => {
    Object.assign(ab, {
      fr: [],
      lat: [],
      att: [],
      pein: [],
      serie: [],
      tIn: 0,
      tInEcoute: 0,
      tVis: 0,
      tFin: 0,
      demarrage: false,
    });
    ab.declencheurs = new Set(declencheurs);
    ab.dejaVisible = !!ab.pVis && verifier(ab.pVis);
    ab.t0 = performance.now();
    ab.actif = true;
    if (!ab.raf) ab.raf = requestAnimationFrame(boucle);
  };
  if (demarrage) {
    ab.demarrage = true;
    ab.pVis = demarrage.vis;
    ab.pFin = demarrage.fin;
    ab.t0 = 0;
    ab.actif = true;
    ab.raf = requestAnimationFrame(boucle);
  }
}

/** Relevé de l'état de la page pendant l'attente : jalons, dernière mutation, animations finies en cours. */
function etatPage() {
  const ab = window.__ab;
  let anims = 0;
  for (const a of document.getAnimations())
    if (a.playState === "running" && a.effect) {
      const c = a.effect.getComputedTiming();
      // Les animations infinies et les comptes à rebours (toasts, barres de progression) ne retardent pas l'état stable.
      if (c.iterations !== Infinity && c.endTime <= 1500) anims++;
    }
  return { tIn: ab.tIn, tVis: ab.tVis, tFin: ab.tFin, lastMut: ab.lastMut, now: performance.now(), anims };
}

/** Lecture et remise à zéro des relevés de la page. */
function lireReleves() {
  const ab = window.__ab;
  ab.actif = false;
  const nav = performance.getEntriesByType("navigation")[0];
  const peintures = Object.fromEntries(
    performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]),
  );
  const r = {
    lt: ab.lt,
    ev: ab.ev,
    ls: ab.ls,
    fr: ab.fr,
    lat: ab.lat,
    tIn: ab.tIn,
    tInEcoute: ab.tInEcoute,
    tVis: ab.tVis,
    tFin: ab.tFin,
    t0: ab.t0,
    dejaVisible: ab.dejaVisible,
    jalons: ab.jalons.map(([nom, , t]) => [nom, t]),
    serie: ab.serie,
    lastMut: ab.lastMut,
    demarrage: ab.demarrage,
    nav: nav
      ? {
          dcl: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd,
          reponse: nav.responseEnd,
        }
      : null,
    peintures,
  };
  ab.lt = [];
  ab.ev = [];
  ab.ls = [];
  return r;
}

/** Ressources chargées depuis l'ouverture de la page : nombre et kilo-octets transférés par type. */
function lireRessources() {
  const parType = {};
  for (const e of performance.getEntriesByType("resource")) {
    const ext = (e.name.split("?")[0].match(/\.(\w+)$/) || [, "autre"])[1];
    const type = /^(js|mjs)$/.test(ext)
      ? "js"
      : /^(css)$/.test(ext)
        ? "css"
        : /woff2?|ttf/.test(ext)
          ? "police"
          : e.initiatorType === "fetch"
            ? "api"
            : ext;
    const t = (parType[type] ??= { n: 0, ko: 0, koDecode: 0 });
    t.n++;
    t.ko += (e.transferSize || 0) / 1024;
    t.koDecode += (e.decodedBodySize || 0) / 1024;
  }
  for (const t of Object.values(parType)) {
    t.ko = Math.round(t.ko);
    t.koDecode = Math.round(t.koDecode);
  }
  // Les plus gros scripts chargés : nom et kilo-octets décodés.
  parType.plusGrosJs = performance
    .getEntriesByType("resource")
    .filter((e) => /\.m?js(\?|$)/.test(e.name))
    .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
    .slice(0, 6)
    .map((e) => `${e.name.split("?")[0].split("/").pop()} ${Math.round(e.decodedBodySize / 1024)}`);
  return parType;
}

const arr = (x) => (x === null || x === undefined ? null : Math.round(x));
const trier = (v) => [...v].sort((a, b) => a - b);
const pct = (t, p) => (t.length ? t[Math.min(t.length - 1, Math.floor(t.length * p))] : null);

/** Résultat d'un geste à partir des relevés de la page, de l'état final et des requêtes. */
function analyser(r, etat, { cdp, requetes, ressources, mode }) {
  const tIn = r.demarrage ? 0 : r.tIn;
  const tStable = Math.max(r.tFin || 0, etat.tStable || 0);
  const tFinFenetre = Math.max(tStable, r.tFin || 0) + 100;
  const dans = (t) => t >= tIn - 2 && t <= tFinFenetre;
  const taches = r.lt.filter(([s, d]) => s + d >= tIn - 2 && s <= tFinFenetre).map(([, d]) => Math.round(d));
  const images = [];
  for (let i = 1; i < r.fr.length; i++)
    if (r.fr[i][0] >= tIn && r.fr[i][0] <= tFinFenetre) images.push(r.fr[i][0] - r.fr[i - 1][0]);
  const ls = r.ls.filter(([t]) => dans(t));
  const lat = trier(r.lat.filter(([, ts]) => ts >= tIn - 2).map(([, ts, t]) => t - ts));
  const ev = r.ev.filter(([, s]) => s >= tIn - 2 && s <= tFinFenetre);
  const somme = (v) => Math.round(v.reduce((a, b) => a + b, 0));
  const res = {
    ok: !!r.tVis && !r.dejaVisible,
    finAtteint: !!r.tFin,
    calme: !etat.delaiDepasse,
    visMs: r.tVis ? arr(r.tVis - tIn) : null,
    finMs: r.tFin ? arr(r.tFin - tIn) : null,
    stableMs: r.tVis ? arr(tStable - tIn) : null,
    latence: null,
    entrees: {
      n: lat.length,
      p50: arr(pct(lat, 0.5)),
      p95: arr(pct(lat, 0.95)),
      max: arr(lat[lat.length - 1] ?? null),
    },
    evenementMax: ev.length ? Math.max(...ev.map(([, , d]) => d)) : 0,
    evenementsLents: ev
      .filter(([, , d]) => d > SEUILS.instantane)
      .map(([n, , d, p]) => `${n} ${Math.round(d)}/${Math.round(p)}`),
    taches: { n: taches.length, totalMs: somme(taches), maxMs: taches.length ? Math.max(...taches) : 0 },
    images: {
      n: images.length,
      lentes: images.filter((d) => d > SEUILS.image).length,
      pireMs: images.length ? arr(Math.max(...images)) : 0,
    },
    decalage: {
      total: Math.round(ls.reduce((a, [, v]) => a + v, 0) * 1000) / 1000,
      sansEntree: Math.round(ls.filter(([, , h]) => !h).reduce((a, [, v]) => a + v, 0) * 1000) / 1000,
      apresVisible:
        Math.round(ls.filter(([t]) => r.tVis && t > r.tVis).reduce((a, [, v]) => a + v, 0) * 1000) / 1000,
    },
    cdp,
    requetes,
  };
  // Latence retenue pour le classement : un geste à une entrée se lit de l'entrée à la réponse visible, une suite d'entrées par le p95 de chaque entrée.
  res.latence = mode === "suite" ? res.entrees.p95 : res.visMs;
  if (r.serie.length) res.imagesVides = r.serie.reduce((a, b) => a + b, 0);
  if (r.jalons.length)
    res.jalons = Object.fromEntries(r.jalons.map(([nom, t]) => [nom, t ? arr(t - tIn) : null]));
  if (r.dejaVisible) res.erreur = "prédicat de réponse déjà vrai avant le geste";
  if (r.demarrage) {
    res.demarrage = {
      fcp: arr(r.peintures["first-contentful-paint"]),
      dcl: arr(r.nav?.dcl),
      load: arr(r.nav?.load),
      ressources,
    };
  }
  return res;
}

/** Attend la réponse visible, l'état final, puis le calme (aucune mutation ni animation finie pendant `calme` ms). */
async function attendreStable(page, { delai = 12000, calme = 400 } = {}) {
  const t0 = Date.now();
  let derniereAnim = 0;
  let etat;
  for (;;) {
    etat = await page.evaluate(etatPage);
    if (etat.anims > 0) derniereAnim = etat.now;
    const pret = etat.tFin > 0;
    if (pret && etat.anims === 0 && etat.now - Math.max(etat.lastMut, etat.tFin) >= calme) break;
    if (Date.now() - t0 > delai) {
      etat.delaiDepasse = true;
      break;
    }
    await pause(40);
  }
  const borne = (x) => (x > etat.tIn ? x : 0);
  etat.tStable = Math.max(etat.tFin, borne(etat.lastMut), borne(derniereAnim));
  return etat;
}

/** Attend que la page soit calme avant un geste (aucune mutation depuis `calme` ms, au plus `delai` ms). */
export async function attendreCalme(page, { calme = 300, delai = 4000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const e = await page.evaluate(etatPage);
    if ((e.now - e.lastMut >= calme && e.anims === 0) || Date.now() - t0 > delai) return;
    await pause(50);
  }
}

/** Mesures CDP cumulées du fil principal (ms). */
async function metriques(cdp) {
  const m = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
  );
  return {
    tache: m.TaskDuration * 1000,
    script: m.ScriptDuration * 1000,
    style: m.RecalcStyleDuration * 1000,
    layout: m.LayoutDuration * 1000,
  };
}
const ecartMetriques = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Math.round(b[k] - a[k])]));

/** Ouvre Chromium (binaire imposé par ELPIS_CHROMIUM, sinon le Chromium complet de Playwright). */
async function lancerChromium(arbre) {
  const nm = process.env.ELPIS_NODE_MODULES || path.join(arbre, "browser-service/node_modules");
  const { chromium } = createRequire(nm.replace(/\/?$/, "/"))("playwright");
  if (process.env.ELPIS_CHROMIUM)
    return chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  try {
    return await chromium.launch({ channel: "chromium", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

/** Contexte connecté (cookie posé par l'API) avec les sondes ; `demarrage` : prédicats de la page qui s'ouvre. */
async function nouveauContexte(banc, { url, compte, rm, demarrage = null }) {
  const ctx = await banc.nav.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: rm });
  const c = new banc.Client(url);
  await c.req("POST", "/api/login-lite", compte);
  const { hostname } = new URL(url);
  await ctx.addCookies([...c.cookies].map(([name, value]) => ({ name, value, domain: hostname, path: "/" })));
  await ctx.addInitScript({ path: path.join(DEPOT, "tests/frontend/lib/acces-racine.js") });
  const pred = demarrage ? `{ vis: ${demarrage.vis.toString()}, fin: ${demarrage.fin.toString()} }` : "null";
  await ctx.addInitScript({ content: `(${sondes.toString()})(${pred});` });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url }).catch(() => {});
  if (url === banc.core.urlMain) await ctx.route("**/api/sandbox/**", simulerBac);
  return ctx;
}

/** Bac de l'utilisateur simulé au niveau réseau (le cœur de test n'a pas de conteneur) : arbre, lecture des fichiers, état. */
async function simulerBac(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const json = (corps, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(corps) });
  if (p === "/api/sandbox/tree") return json(bac.arbre(ARBRE_BAC));
  if (p === "/api/sandbox/download") {
    const chemin = url.searchParams.get("path") || "";
    if (!(chemin in FICHIERS_BAC)) return json({ detail: "absent" }, 404);
    return route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: FICHIERS_BAC[chemin],
    });
  }
  if (p === "/api/sandbox/quota") return json(bac.quota({ used_mb: 12, quota_mb: 5120 }));
  if (p === "/api/sandbox/me") return json(bac.moi());
  if (p === "/api/sandbox/check-mtimes") return json(bac.etats());
  return json({});
}

/** Page d'un contexte : CDP, ralentissement du processeur, journal des requêtes et des erreurs. */
async function nouvellePage(ctx, cpuRate) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const h = { page, cdp, ctx, erreurs: [], requetes: [] };
  page.on("pageerror", (e) => h.erreurs.push(String(e?.message || e).slice(0, 300)));
  page.on("requestfinished", (req) => {
    const t = req.timing();
    h.requetes.push({
      url: req.url().replace(/^https?:\/\/[^/]+/, ""),
      debut: t.startTime,
      ms: Math.round(Math.max(0, t.responseEnd)),
    });
  });
  return h;
}

/** Requêtes de l'API terminées pendant le geste : nombre, plus longue, chemins. */
function requetesDuGeste(h, depuis) {
  const v = h.requetes.filter((r) => r.debut >= depuis && r.url.startsWith("/api/"));
  const max = v.reduce((m, r) => (r.ms > m.ms ? r : m), { ms: 0, url: "" });
  return {
    n: v.length,
    maxMs: max.ms,
    plusLongue: max.url.split("?")[0],
    chemins: [...new Set(v.map((r) => r.url.split("?")[0]))].slice(0, 8),
  };
}

/** Mesure un geste : préparation, armement, entrée, attente de la réponse et du calme, relevés. */
export async function mesurerGeste(h, geste, { profil = null } = {}) {
  const { page, cdp } = h;
  if (geste.nonMesure) return { res: { ok: false, nonMesure: geste.nonMesure } };
  try {
    if (geste.prep) await geste.prep(h);
  } catch (e) {
    // Une préparation impossible avec le cœur de test (« NON MESURÉ: raison ») n'est pas un échec du geste.
    const m = String(e.message);
    if (m.startsWith("NON MESURÉ:")) return { res: { ok: false, nonMesure: m.slice(11).trim() } };
    throw new Error(`préparation : ${m.split("\n")[0]}`);
  }
  if (geste.calmeAvant !== false) await attendreCalme(page);
  const declencheurs = geste.entrees || ["pointerdown", "keydown", "wheel", "paste", "change"];
  const arg = typeof geste.arg === "function" ? await geste.arg(h) : (geste.arg ?? null);
  const jalons = Object.entries(geste.jalons || {}).map(
    ([nom, f]) => `[${JSON.stringify(nom)}, ${f.toString()}, 0]`,
  );
  await page.evaluate(
    `(() => { const ab = window.__ab; ab.pVis = ${geste.vis.toString()}; ab.pFin = ${(geste.fin || geste.vis).toString()}; ab.arg = ${JSON.stringify(arg)}; ab.jalons = [${jalons.join(", ")}]; ab.parImage = ${geste.parImage ? geste.parImage.toString() : "null"}; ab.armer(${JSON.stringify(declencheurs)}); })()`,
  );
  if (profil) await profil.demarrer();
  await pause(120);
  const m0 = await metriques(cdp);
  const depuis = Date.now();
  let erreur = null;
  try {
    await geste.faire(h);
  } catch (e) {
    erreur = String(e.message).split("\n")[0].slice(0, 200);
  }
  const etat = erreur
    ? { delaiDepasse: true, tStable: 0 }
    : await attendreStable(page, { delai: geste.delai, calme: geste.calme });
  const m1 = await metriques(cdp);
  const brut = profil ? await profil.arreter() : null;
  const r = await page.evaluate(lireReleves);
  const res = analyser(r, etat, {
    cdp: ecartMetriques(m0, m1),
    requetes: requetesDuGeste(h, depuis - 50),
    mode: geste.mode,
  });
  if (erreur) res.erreur = erreur;
  if (geste.apres) await geste.apres(h).catch(() => {});
  return {
    res,
    brut,
    fenetre: [r.tIn, Math.max(r.tFin || 0, etat.tStable || 0) + 100],
    tInEcoute: r.tInEcoute,
  };
}

/** Mesure un démarrage : contexte neuf (froid) ou rechargement du même contexte (chaud), sondes armées dès la navigation. */
async function mesurerDemarrage(banc, geste, params, { profil = false } = {}) {
  const cpuRate = params.cpuRate;
  const ctx = await nouveauContexte(banc, {
    url: geste.url(banc),
    compte: geste.compte(banc),
    rm: params.rm,
    demarrage: geste,
  });
  try {
    const h = await nouvellePage(ctx, cpuRate);
    if (geste.chaud) {
      await h.page.goto(geste.url(banc) + "/");
      await attendreStable(h.page, { delai: 30000, calme: 600 });
      await pause(300);
    } else if (profil) {
      // Profil d'un démarrage froid : une page légère de la même origine d'abord, pour que l'échantillonneur reste sur le même processus.
      await h.page.goto(geste.url(banc) + "/api/public-config");
    }
    const prof = profil ? await debutProfil(banc, h) : null;
    // Les compteurs CDP repartent de zéro avec le nouveau document : le relevé final est le coût du démarrage.
    const m0 = { tache: 0, script: 0, style: 0, layout: 0 };
    const depuis = Date.now();
    if (geste.chaud) await h.page.reload();
    else await h.page.goto(geste.url(banc) + "/");
    const etat = await attendreStable(h.page, { delai: 30000, calme: 600 });
    const m1 = await metriques(h.cdp);
    const brut = prof ? await prof.arreter() : null;
    const r = await h.page.evaluate(lireReleves);
    const ressources = await h.page.evaluate(lireRessources);
    const res = analyser(r, etat, {
      cdp: ecartMetriques(m0, m1),
      requetes: requetesDuGeste(h, depuis - 50),
      ressources,
      mode: "unique",
    });
    if (h.erreurs.length) res.erreursPage = h.erreurs.slice(0, 5);
    return { res, brut, fenetre: [0, Math.max(r.tFin || 0, etat.tStable || 0) + 100], h };
  } finally {
    if (!profil) await ctx.close();
  }
}

/** Démarre le vrai cœur d'un arbre (faux moteur, clé de coffre et journal jetables), pose les données et ouvre Chromium. */
export async function ouvrirBanc({ arbre = DEPOT } = {}) {
  const { demarrerCoreReel, Client } = await import(
    pathToFileURL(path.join(arbre, "tests/frontend/lib/core-reel.mjs")).href
  );
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "banc-app-"));
  let cle = process.env.ELPIS_VAULT_KEY_PATH;
  if (!cle) {
    cle = path.join(dossier, "coffre.key");
    fs.writeFileSync(cle, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const core = await demarrerCoreReel({
    tokParS: 200,
    outilsEnProcessus: true,
    envSup: {
      ELPIS_VAULT_KEY_PATH: cle,
      ELPIS_AUDIT_KEY_PATH: process.env.ELPIS_AUDIT_KEY_PATH || "/nonexistent",
    },
  });
  const arreter = async () => {
    await banc.nav?.close().catch(() => {});
    await banc.donnees?.arreter?.().catch(() => {});
    await core.arreter();
    fs.rmSync(dossier, { recursive: true, force: true });
  };
  const banc = { core, Client, arbre, arreter };
  try {
    banc.donnees = await poserDonnees(core, Client);
    banc.nav = await lancerChromium(arbre);
    return banc;
  } catch (e) {
    await arreter();
    throw e;
  }
}

/** Ouvre la page du chat (ou de la console) connectée, montée et calme. */
async function ouvrirApplication(banc, { console: estConsole = false, cpuRate, rm }) {
  const url = estConsole ? banc.core.urlAdmin : banc.core.urlMain;
  const compte = estConsole ? banc.core.comptes.admin : banc.core.comptes.user;
  const ctx = await nouveauContexte(banc, { url, compte, rm });
  const h = await nouvellePage(ctx, cpuRate);
  h.banc = banc;
  h.url = url;
  await h.page.goto(url + "/");
  await h.page.waitForFunction(
    () => {
      const a = document.getElementById("app");
      return a && !a.hasAttribute("v-cloak");
    },
    null,
    { timeout: 60000, polling: 100 },
  );
  await h.page.evaluate(() => document.fonts.ready);
  await attendreCalme(h.page, { calme: 600, delai: 8000 });
  // Les chargements différés au repos (coloration, éditeur…) passent avant le premier geste : 2 s sans tâche longue, au plus 20 s.
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const calme = await h.page.evaluate(() => {
      const lt = window.__ab.lt;
      const fin = lt.length ? lt[lt.length - 1][0] + lt[lt.length - 1][1] : 0;
      return performance.now() - fin >= 2000;
    });
    if (calme) break;
    await pause(250);
  }
  return h;
}

/** Filtre de gestes : expression régulière sur le nom (insensible à la casse). */
const garder = (filtre) => (g) => !filtre || new RegExp(filtre, "i").test(g.nom);

/** Une passe : démarrages, gestes du chat, gestes de la console ; un résultat par geste, dans l'ordre. */
export async function passe(banc, params) {
  const { cpuRate = 4, rm = "no-preference", filtre = "", journal = () => {} } = params;
  const sortie = [];
  const noter = (geste, res) => {
    sortie.push({
      nom: geste.nom,
      groupe: geste.groupe,
      selecteur: geste.selecteur || "",
      mode: geste.mode || "unique",
      ...res,
    });
    journal(geste, res);
  };
  for (const geste of gestesDemarrage().filter(garder(filtre))) {
    try {
      const { res } = await mesurerDemarrage(banc, geste, { cpuRate, rm });
      noter(geste, res);
    } catch (e) {
      noter(geste, { ok: false, erreur: String(e.message).split("\n")[0].slice(0, 200) });
    }
  }
  for (const [estConsole, catalogue] of [
    [false, gestesChat],
    [true, gestesConsole],
  ]) {
    if (
      !(await catalogue(null, null)).some(garder(filtre)) &&
      !(estConsole && /console/i.test(filtre || "console"))
    )
      continue;
    let h = await ouvrirApplication(banc, { console: estConsole, cpuRate, rm });
    const gestes = (await catalogue(banc, h)).filter(garder(filtre));
    for (const geste of gestes) {
      let res;
      try {
        ({ res } = await mesurerGeste(h, geste));
      } catch (e) {
        res = { ok: false, erreur: String(e.message).split("\n")[0].slice(0, 200) };
      }
      if (h.erreurs.length) res.erreursPage = h.erreurs.splice(0).slice(0, 5);
      noter(geste, res);
      if (!res.ok && !res.nonMesure) {
        // Retour à un état connu : la page est rouverte si le geste l'a laissée dans un état inattendu.
        await h.ctx.close().catch(() => {});
        h = await ouvrirApplication(banc, { console: estConsole, cpuRate, rm });
      }
    }
    await h.ctx.close();
  }
  return sortie;
}

/** Début d'un profil : échantillonneur V8 (100 µs) et trace du fil de rendu ; `arreter` rend le profil et les événements. */
async function debutProfil(banc, h) {
  await h.cdp.send("Profiler.enable");
  await h.cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await banc.nav.startTracing(h.page, {
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.stack",
      "blink.user_timing",
    ],
  });
  await h.cdp.send("Profiler.start");
  return {
    async arreter() {
      const { profile } = await h.cdp.send("Profiler.stop");
      const trace = JSON.parse((await banc.nav.stopTracing()).toString()).traceEvents;
      return { profile, trace };
    },
  };
}

/** Profil de gestes nommés : même préparation que la passe, puis profil et trace pendant le geste, dépouillés avec les cartes de sources. */
export async function profiler(banc, params, noms, { cartes = null, garderBrut = null } = {}) {
  const { cpuRate = 4, rm = "no-preference" } = params;
  const lecteur = cartes ? lecteurCartes(cartes, path.join(banc.arbre, "frontend/dist/assets")) : null;
  const sortie = [];
  // Gestes voulus : une liste de noms, ou une expression régulière sur le nom.
  const voulu = (g) => (noms instanceof RegExp ? noms.test(g.nom) : noms.includes(g.nom));
  for (const geste of gestesDemarrage().filter(voulu)) {
    try {
      const { res, brut, h } = await mesurerDemarrage(banc, geste, { cpuRate, rm }, { profil: true });
      sortie.push({ nom: geste.nom, visMs: res.visMs, stableMs: res.stableMs, ...depouiller(brut, lecteur) });
      if (garderBrut) ecrireBrut(garderBrut, geste.nom, brut);
      await h.ctx.close();
    } catch (e) {
      sortie.push({ nom: geste.nom, erreur: String(e.message).split("\n")[0].slice(0, 200) });
    }
  }
  for (const [estConsole, catalogue] of [
    [false, gestesChat],
    [true, gestesConsole],
  ]) {
    if (
      !(await catalogue(null, null)).some(voulu) &&
      !(
        estConsole &&
        (noms instanceof RegExp ? /console/i.test(noms.source) : noms.some((n) => n.startsWith("Console : ")))
      )
    )
      continue;
    const h = await ouvrirApplication(banc, { console: estConsole, cpuRate, rm });
    for (const geste of (await catalogue(banc, h)).filter(voulu)) {
      const prof = {
        async demarrer() {
          this.p = await debutProfil(banc, h);
        },
        arreter() {
          return this.p.arreter();
        },
      };
      try {
        const { res, brut, fenetre, tInEcoute } = await mesurerGeste(h, geste, { profil: prof });
        sortie.push({
          nom: geste.nom,
          visMs: res.visMs,
          stableMs: res.stableMs,
          ...depouiller(brut, lecteur, { fenetre, tInEcoute }),
        });
        if (garderBrut) ecrireBrut(garderBrut, geste.nom, brut);
      } catch (e) {
        sortie.push({ nom: geste.nom, erreur: String(e.message).split("\n")[0].slice(0, 200) });
      }
    }
    await h.ctx.close();
  }
  return sortie;
}

function ecrireBrut(dossier, nom, brut) {
  fs.mkdirSync(dossier, { recursive: true });
  const base = nom.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60);
  fs.writeFileSync(path.join(dossier, base + ".cpuprofile"), JSON.stringify(brut.profile));
}

/** Lecteur des cartes de sources d'un build fait à part (`vite build --sourcemap --outDir …`) : position du bundle → fichier et ligne d'origine. */
function lecteurCartes(dossier, servis) {
  let SourceMapConsumer = null;
  try {
    ({ SourceMapConsumer } = createRequire(path.join(DEPOT, "package.json"))("source-map-js"));
  } catch {
    return null;
  }
  const cache = new Map();
  // Les cartes portent leur propre empreinte quand le commentaire de carte change celle d'un fichier ou de ses imports : repli sur le préfixe du nom s'il est unique.
  const cartes = fs.existsSync(dossier) ? fs.readdirSync(dossier).filter((f) => f.endsWith(".js.map")) : [];
  const prefixe = (f) => f.replace(/-[A-Za-z0-9_-]{8}\.js(\.map)?$/, "");
  const trouver = (fichier) => {
    if (cartes.includes(fichier + ".map")) return path.join(dossier, fichier + ".map");
    const memes = cartes.filter((c) => prefixe(c) === prefixe(fichier));
    if (memes.length === 1) return path.join(dossier, memes[0]);
    // Plusieurs fichiers du même nom : celui dont la taille, commentaire de carte retiré, est celle du fichier servi.
    let taille = -1;
    try {
      taille = fs.statSync(path.join(servis, fichier)).size;
    } catch {
      return null;
    }
    const bon = memes.find((c) => {
      const js = c.replace(/\.map$/, "");
      const commentaire = `\n//# sourceMappingURL=${c}`.length;
      return Math.abs(fs.statSync(path.join(dossier, js)).size - commentaire - taille) <= 1;
    });
    return bon ? path.join(dossier, bon) : null;
  };
  return (cf) => {
    const fichier = (cf.url || "").split("?")[0].split("/").pop();
    if (!fichier.endsWith(".js")) return null;
    if (!cache.has(fichier)) {
      const f = trouver(fichier);
      cache.set(fichier, f ? new SourceMapConsumer(JSON.parse(fs.readFileSync(f, "utf8"))) : null);
    }
    const c = cache.get(fichier);
    if (!c) return null;
    if (cf.lineNumber < 0) return null;
    const p = c.originalPositionFor({ line: cf.lineNumber + 1, column: Math.max(0, cf.columnNumber) });
    if (!p.source) return null;
    const src = p.source.replace(/^.*?\/(src|node_modules)\//, "$1/");
    return { fichier: src, fn: `${p.name || cf.functionName || "(anonyme)"} ${src}:${p.line}` };
  };
}

// Familles d'événements de trace du fil de rendu, comptées en temps propre (enfants retirés) ; la première qui correspond l'emporte.
const FAMILLES = [
  ["gc", /^(MinorGC|MajorGC|V8\.GC|BlinkGC|ThreadState::|CppGC)/],
  ["style", /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet)$/],
  [
    "layout",
    /^(Layout|UpdateLayer|UpdateLayerTree|IntersectionObserverController::computeIntersections|ResizeObserver)/,
  ],
  [
    "peinture",
    /^(Paint|PrePaint|Layerize|Commit|PaintImage|Decode Image|ImageDecodeTask|CompositeLayers|Rasterize)/,
  ],
  ["html", /^ParseHTML$/],
  [
    "script",
    /^(FunctionCall|EvaluateScript|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|FireIdleCallback|v8\.|V8\.|CompileScript|CompileCode|XHRReadyStateChange|XHRLoad|ParseScript|HandlePostMessage)/,
  ],
];

/** Dépouille un profil et sa trace dans la fenêtre du geste (temps de la page `fenetre`, recalés sur le repère « ab-entree ») : temps propre par fonction (sources d'origine), par fichier, et par famille de la trace. */
function depouiller(brut, lecteur, { fenetre = null, tInEcoute = 0 } = {}) {
  const { profile, trace } = brut;
  // Fil principal de la page : celui qui porte le repère « ab-entree », sinon le CrRendererMain le plus chargé.
  const reperes = trace.filter((e) => e.name === "TimeStamp" && e.args?.data?.message === "ab-entree");
  let fil = reperes.length ? `${reperes[0].pid}:${reperes[0].tid}` : null;
  if (!fil) {
    const charges = new Map();
    const principaux = new Set(
      trace
        .filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")
        .map((e) => `${e.pid}:${e.tid}`),
    );
    for (const e of trace)
      if (e.ph === "X" && principaux.has(`${e.pid}:${e.tid}`))
        charges.set(`${e.pid}:${e.tid}`, (charges.get(`${e.pid}:${e.tid}`) || 0) + (e.dur || 0));
    fil = [...charges.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  // Fenêtre sur l'horloge de la trace : le repère est posé à `tInEcoute` (temps de la page) ; sans repère (démarrage), tout le profil.
  const recaler = (tPage) => reperes[0].ts + (tPage - tInEcoute) * 1000;
  const tDebut = reperes.length && fenetre ? recaler(fenetre[0]) - 2000 : profile.startTime;
  const tFin = reperes.length && fenetre ? recaler(fenetre[1]) : Infinity;
  const evs = trace
    .filter(
      (e) => e.ph === "X" && `${e.pid}:${e.tid}` === fil && e.ts + (e.dur || 0) >= tDebut && e.ts <= tFin,
    )
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  // Temps propre de chaque événement : sa durée moins celle de ses enfants directs.
  const pile = [];
  const familles = { script: 0, style: 0, layout: 0, peinture: 0, gc: 0, html: 0, autre: 0 };
  const parNom = new Map();
  const taches = [];
  for (const e of evs) {
    while (pile.length && pile[pile.length - 1].fin <= e.ts) pile.pop();
    const n = { e, fin: e.ts + (e.dur || 0), enfants: 0 };
    if (pile.length) pile[pile.length - 1].enfants += e.dur || 0;
    pile.push(n);
    e._noeud = n;
    if (e.name === "RunTask" && e.dur > SEUILS.tache * 1000) taches.push(Math.round(e.dur / 1000));
  }
  for (const e of evs) {
    const propre = Math.max(0, (e.dur || 0) - e._noeud.enfants) / 1000;
    const fam = FAMILLES.find(([, re]) => re.test(e.name))?.[0] || "autre";
    familles[fam] += propre;
    parNom.set(e.name, (parNom.get(e.name) || 0) + propre);
  }
  for (const k of Object.keys(familles)) familles[k] = Math.round(familles[k]);
  // Recalculs de style (éléments touchés) et mises en page (objets à refaire, forcées par un script ou non).
  const styles = evs.filter((e) => e.name === "UpdateLayoutTree");
  const layouts = evs.filter((e) => e.name === "Layout");
  const pipeline = {
    styles: styles.length,
    elementsStyles: styles.reduce((a, e) => a + (e.args?.elementCount || 0), 0),
    layouts: layouts.length,
    layoutsForces: layouts.filter((e) => e.args?.beginData?.stackTrace?.length).length,
    objetsLayout: layouts.reduce((a, e) => a + (e.args?.beginData?.dirtyObjects || 0), 0),
  };
  // Échantillons du profil datés sur l'horloge de la trace, gardés dans la fenêtre du geste.
  const noeuds = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const origine = new Map();
  const nommer = (n) => {
    if (!origine.has(n.id)) {
      const cf = n.callFrame;
      const o = lecteur && lecteur(cf);
      const court = (cf.url || "").split("?")[0].split("/").pop();
      origine.set(
        n.id,
        o || {
          fichier: court || "(natif)",
          fn: `${cf.functionName || "(anonyme)"} ${court ? court + ":" + (cf.lineNumber + 1) : ""}`.trim(),
        },
      );
    }
    return origine.get(n.id);
  };
  const propres = new Map();
  const fichiers = new Map();
  const totaux = new Map();
  let t = profile.startTime;
  let occupe = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] || 0;
    const d = (profile.timeDeltas[i + 1] || 0) / 1000;
    if (t < tDebut || t > tFin || d <= 0) continue;
    const n = noeuds.get(profile.samples[i]);
    const nomFn = n.callFrame.functionName;
    if (["(idle)", "(root)", "(program)"].includes(nomFn)) continue;
    occupe += d;
    const o = nommer(n);
    propres.set(o.fn, (propres.get(o.fn) || 0) + d);
    fichiers.set(o.fichier, (fichiers.get(o.fichier) || 0) + d);
    const vus = new Set();
    for (let id = n.id; id !== undefined; id = parent.get(id)) {
      const x = noeuds.get(id);
      if (x.callFrame.functionName === "(root)") break;
      const f = nommer(x).fn;
      if (vus.has(f)) continue;
      vus.add(f);
      totaux.set(f, (totaux.get(f) || 0) + d);
    }
  }
  const top = (m, k = 15) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([nom, ms]) => [Math.round(ms * 10) / 10, nom]);
  return {
    occupeMs: Math.round(occupe),
    familles,
    evenementsTrace: top(parNom, 12),
    pipeline,
    tachesLongues: taches,
    fonctionsPropre: top(propres, 20),
    fonctionsTotal: top(totaux, 15),
    fichiers: top(fichiers, 12),
  };
}

/** Médiane d'une liste de nombres (null ignorés). */
export const mediane = (v) => {
  const t = trier(v.filter((x) => typeof x === "number"));
  if (!t.length) return null;
  const m = t.length >> 1;
  return t.length % 2 ? t[m] : Math.round(((t[m - 1] + t[m]) / 2) * 1000) / 1000;
};

/** Résumé de plusieurs passes : médianes par geste, dans l'ordre de la première passe. */
export function resumer(passes) {
  const noms = [...new Set(passes.flatMap((p) => p.map((g) => g.nom)))];
  return noms.map((nom) => {
    const v = passes.map((p) => p.find((g) => g.nom === nom)).filter(Boolean);
    const m = (f) =>
      mediane(v.map((g) => (g.ok || g.visMs != null ? f(g) : null)).map((x) => (x === undefined ? null : x)));
    const premier = v[0];
    return {
      nom,
      groupe: premier.groupe,
      selecteur: premier.selecteur,
      mode: premier.mode,
      passes: v.length,
      reussies: v.filter((g) => g.ok).length,
      nonMesure: premier.nonMesure || null,
      erreurs: [...new Set(v.map((g) => g.erreur).filter(Boolean))],
      latence: m((g) => g.latence),
      visMs: m((g) => g.visMs),
      stableMs: m((g) => g.stableMs),
      entreesP50: m((g) => g.entrees?.p50),
      entreesP95: m((g) => g.entrees?.p95),
      evenementMax: m((g) => g.evenementMax),
      tacheMax: m((g) => g.taches?.maxMs),
      tachesTotal: m((g) => g.taches?.totalMs),
      tachesN: m((g) => g.taches?.n),
      imagesLentes: m((g) => g.images?.lentes),
      pireImage: m((g) => g.images?.pireMs),
      decalage: m((g) => g.decalage?.total),
      decalageApres: m((g) => g.decalage?.apresVisible),
      script: m((g) => g.cdp?.script),
      style: m((g) => g.cdp?.style),
      layout: m((g) => g.cdp?.layout),
      requetes: m((g) => g.requetes?.n),
      requeteMax: m((g) => g.requetes?.maxMs),
      imagesVides: m((g) => g.imagesVides),
      jalons: premier.jalons
        ? Object.fromEntries(Object.keys(premier.jalons).map((k) => [k, m((g) => g.jalons?.[k])]))
        : null,
      evenementsLents: [...new Set(v.flatMap((g) => g.evenementsLents || []))].slice(0, 6),
      demarrage: premier.demarrage || null,
    };
  });
}

/** Lenteur d'un geste : sa latence ou, si elle est plus longue, sa pire tâche (le fil est bloqué pendant ce temps, même après la réponse visible). */
export const lenteur = (g) =>
  g.latence === null || g.latence === undefined ? -1 : Math.max(g.latence, g.tacheMax ?? 0);

/** Classement du plus lent au plus rapide (lenteur, puis latence). */
export function classer(resume) {
  return [...resume].sort((a, b) => lenteur(b) - lenteur(a) || (b.latence ?? -1) - (a.latence ?? -1));
}

/** Tableau lisible d'un résumé classé. */
export function tableau(resume) {
  // Entiers, sauf le décalage (score sans unité, trois décimales) ; une colonne d'écart au moins.
  const col = (v, n) =>
    (
      " " +
      (typeof v === "number"
        ? String(v < 1 && v > 0 ? Math.round(v * 1000) / 1000 : Math.round(v))
        : (v ?? "-"))
    ).padStart(n);
  const lignes = [
    `${"geste".padEnd(48)}${col("latence", 8)}${col("stable", 8)}${col("p95/ent", 8)}${col("tâche", 7)}${col("Σtâches", 8)}${col("img>33", 7)}${col("pire", 6)}${col("décal.", 7)}${col("req", 5)}  état`,
  ];
  for (const g of classer(resume)) {
    const etat = g.nonMesure
      ? `non mesuré : ${g.nonMesure}`
      : g.reussies < g.passes
        ? `${g.reussies}/${g.passes} ${g.erreurs.join(" ; ").slice(0, 60)}`
        : "";
    lignes.push(
      `${g.nom.slice(0, 47).padEnd(48)}${col(g.latence, 8)}${col(g.stableMs, 8)}${col(g.entreesP95, 8)}${col(g.tacheMax, 7)}${col(g.tachesTotal, 8)}${col(g.imagesLentes, 7)}${col(g.pireImage, 6)}${col(g.decalage, 7)}${col(g.requetes, 5)}  ${etat}`,
    );
  }
  return lignes.join("\n");
}
