// SPDX-License-Identifier: MIT
/** tests/perf/scenarios/k_stream_fluidite.mjs — fluidité d'un flux sur le vrai cœur (faux moteur) : cadence, délai reçu → affiché, suivi du bas, fin de tour, balisage brut, animations, frappe ; verdict contre les cibles du plan */
// Hors matrice du faux serveur (seul le vrai cœur envoie une fin de tour valide) : lancé par tests/frontend/stream-fluidity-verify.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REFLEXION, reponseMixte } from "../fixtures/fluidity_reply.mjs";
import { launch, startWindow, stopWindow } from "../lib/harness.mjs";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ARRET = 'button[title="Arrêter la génération"]';
const ENVOYER = "button:has(i.ph-paper-plane-right)";
const SAISIE = "textarea[placeholder]";
// Texte en attente en deçà duquel le fil est considéré à jour (bruit de l'estimation de longueur rendue).
const TOLERANCE_ATTENTE = 8;
// Hors mouvement réduit, le suivi glisse vers le bas avec au plus ECART_MAX_PX = 48 px de retard (rendu-flux.ts), plus 4 px d'arrondi.
const ECART_GLISSE_PX = 52;

/** Instrumentation posée avant l'application : repères reçus, salves simulées (enveloppe de fetch), événements du flux, lecture du DOM. */
function instrumenter(burstMs) {
  const fl = (window.__fl = {
    arr: {},
    vis: {},
    pos: {},
    trames: [],
    recu: [],
    finalA: 0,
    envoiA: 0,
    burstMs,
    texteRecu: "",
    jalons: {},
    types: {},
    avantFinal: null,
  });
  // Dernier corps Markdown de message assistant.
  fl.corpsCourant = () => {
    const tous = document.querySelectorAll(".elpis-msg-assistant .markdown-body");
    return tous[tous.length - 1] || null;
  };
  // Blocs de premier niveau d'un corps : les enveloppes `display: contents` sont traversées, le curseur de flux ignoré.
  fl.blocs = (corps) => {
    const sortie = [];
    const aplatir = (el) => {
      for (const e of el.children) {
        if (e.tagName === "DIV" && (e.getAttribute("style") || "").includes("contents")) aplatir(e);
        else if (!e.classList.contains("elpis-stream-caret")) sortie.push(e);
      }
    };
    aplatir(corps);
    return sortie;
  };
  // Structure du corps : suite des étiquettes de premier niveau, position de chaque bloc repère (pre, titres, tableau, citation).
  fl.structure = () => {
    const corps = fl.corpsCourant();
    if (!corps) return null;
    const haut = corps.getBoundingClientRect().top;
    const etiquette = (e) =>
      e.tagName.toLowerCase() + (e.getAttribute("class") ? "." + e.getAttribute("class").split(" ")[0] : "");
    return {
      flux: corps.getAttribute("aria-busy") === "true",
      hauteur: Math.round(corps.getBoundingClientRect().height),
      etiquettes: fl.blocs(corps).map(etiquette),
      ancres: [...corps.querySelectorAll("pre, h1, h2, h3, table, blockquote")].map((e) => [
        e.tagName.toLowerCase(),
        Math.round(e.getBoundingClientRect().top - haut),
      ]),
      noeuds: corps.querySelectorAll("*").length,
    };
  };
  const natif = window.fetch;
  window.fetch = async function (entree) {
    const url = String(typeof entree === "string" ? entree : (entree && entree.url) || "");
    const estFlux = url.includes("/api/chat-saved-stream3");
    const creation = url.includes("/api/saved/chats/new");
    if (estFlux) fl.jalons.requete = performance.now();
    else if (creation) fl.jalons.creationDebut = performance.now();
    const res = await natif.apply(this, arguments);
    if (creation) fl.jalons.creationFin = performance.now();
    if (!estFlux || !res.body) return res;
    fl.jalons.entetes = performance.now();
    const dec = new TextDecoder();
    let reste = "";
    // Date l'arrivée de chaque repère et de la fin de tour dans les octets lus.
    const noter = (octets) => {
      const t = performance.now();
      reste += dec.decode(octets, { stream: true });
      let nl;
      while ((nl = reste.indexOf("\n")) >= 0) {
        const ligne = reste.slice(0, nl);
        reste = reste.slice(nl + 1);
        if (!ligne.trim()) continue;
        try {
          const ev = JSON.parse(ligne);
          if (!(ev.type in fl.types)) fl.types[ev.type] = Math.round(t);
          if (ev.type === "content_token") {
            const avant = fl.texteRecu.length;
            fl.texteRecu += ev.text || "";
            fl.recu.push([t, fl.texteRecu.length]);
            const re = /zq(\d{3})/g;
            re.lastIndex = Math.max(0, avant - 5);
            for (let m = re.exec(fl.texteRecu); m; m = re.exec(fl.texteRecu))
              if (!(m[1] in fl.arr)) fl.arr[m[1]] = t;
          } else if (ev.type === "final") {
            fl.finalA = t;
            fl.avantFinal = fl.structure();
          }
        } catch {
          /* ligne partielle ignorée */
        }
      }
    };
    const lecteur = res.body.getReader();
    const flux = new ReadableStream({
      start(ctrl) {
        let attente = [];
        let fini = false;
        let minuterie = null;
        const vider = () => {
          if (attente.length) {
            const total = new Uint8Array(attente.reduce((s, a) => s + a.length, 0));
            let o = 0;
            for (const a of attente) {
              total.set(a, o);
              o += a.length;
            }
            attente = [];
            noter(total);
            ctrl.enqueue(total);
          }
          if (fini) {
            clearInterval(minuterie);
            ctrl.close();
          }
        };
        if (burstMs > 0) minuterie = setInterval(vider, burstMs);
        (async () => {
          for (;;) {
            const { value, done } = await lecteur.read();
            if (done) {
              fini = true;
              if (!(burstMs > 0)) ctrl.close();
              return;
            }
            if (burstMs > 0) attente.push(value);
            else {
              noter(value);
              ctrl.enqueue(value);
            }
          }
        })();
      },
    });
    return new Response(flux, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Échantillonneur par image, lu APRÈS la peinture (message posté depuis requestAnimationFrame) : texte affiché, repères visibles, écart au bas, hauteur du corps, balisage brut, marge du caret au-dessus du composeur. */
function demarrerEchantillonneur(nReperes) {
  const fl = window.__fl;
  fl.brut = { images: 0, gras: 0, accent: 0, marqueur: 0 };
  fl.nU0 = document.querySelectorAll(".elpis-msg-user").length;
  fl.nA0 = document.querySelectorAll(".elpis-msg-assistant").length;
  let prochain = 1;
  const canal = new MessageChannel();
  const cle = (k) => String(k).padStart(3, "0");
  canal.port1.onmessage = () => {
    const t = performance.now();
    const corps = fl.corpsCourant();
    // Le conteneur du fil est le parent de la colonne du chat.
    const cont = (document.querySelector(".elpis-chat-col") || {}).parentElement;
    const txt = corps ? corps.textContent || "" : "";
    while (prochain <= nReperes) {
      const i = txt.indexOf("zq" + cle(prochain));
      if (i < 0) break;
      fl.vis[cle(prochain)] = t;
      fl.pos[cle(prochain)] = i + 5;
      prochain++;
    }
    const j = fl.jalons;
    if (fl.envoiA) {
      const nU = document.querySelectorAll(".elpis-msg-user").length;
      const lignes = document.querySelectorAll(".elpis-msg-assistant");
      const derniere = lignes[lignes.length - 1];
      if (!j.bulleUser && nU > fl.nU0) j.bulleUser = t;
      if (!j.bulleAssistant && lignes.length > fl.nA0) j.bulleAssistant = t;
      if (
        !j.indicateur &&
        lignes.length > fl.nA0 &&
        derniere &&
        derniere.querySelector(
          ".animate-ping, .mem-wave, .elpis-stream-caret, .animate-spin, .animate-pulse, .elpis-typing",
        )
      )
        j.indicateur = t;
      if (!j.texte && lignes.length > fl.nA0 && txt.trim()) j.texte = t;
    }
    const enFlux = !!corps && corps.getAttribute("aria-busy") === "true";
    if (enFlux) {
      fl.brut.images++;
      let hors = "";
      for (const n of fl.blocs(corps))
        if (n.tagName !== "PRE" && !n.classList.contains("code-wrapper")) hors += n.textContent;
      if (hors.includes("**")) fl.brut.gras++;
      if (hors.includes("`")) fl.brut.accent++;
      if (/(^|\n)\s*(#{1,6}|[-*+]|\d+\.|\|.*)\s*$/.test(hors.slice(-12))) fl.brut.marqueur++;
    }
    // Le dernier texte affiché est au caret : sa marge au-dessus du composeur dit s'il est encore visible.
    const caret = enFlux ? corps.querySelector(".elpis-stream-caret") : null;
    const compo = caret ? document.querySelector(".elpis-compose-col") : null;
    fl.trames.push([
      Math.round(t * 10) / 10,
      txt.length,
      cont ? Math.round(cont.scrollTop) : -1,
      cont ? Math.round(cont.scrollHeight - cont.scrollTop - cont.clientHeight) : -1,
      corps ? Math.round(corps.getBoundingClientRect().height) : 0,
      enFlux ? 1 : 0,
      compo ? Math.round(compo.getBoundingClientRect().top - caret.getBoundingClientRect().bottom) : null,
    ]);
  };
  const boucle = () => {
    canal.port2.postMessage(0);
    fl._raf = requestAnimationFrame(boucle);
  };
  fl._raf = requestAnimationFrame(boucle);
}

/** Animations en cours (nom, cible, propriétés animées) : celles du fil principal coûtent à chaque image. */
function lireAnimations() {
  const exclus = ["offset", "computedOffset", "easing", "composite"];
  return document.getAnimations().map((a) => {
    const c = a.effect && a.effect.target;
    const props =
      a.effect && a.effect.getKeyframes
        ? [
            ...new Set(
              a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !exclus.includes(p))),
            ),
          ]
        : [];
    const cible = c
      ? c.tagName.toLowerCase() +
        "." +
        String(c.className && c.className.baseVal !== undefined ? c.className.baseVal : c.className)
          .split(" ")
          .slice(0, 3)
          .join(".")
      : "?";
    return (
      (a.animationName || "transition:" + a.transitionProperty) +
      " @ " +
      cible +
      " [" +
      props.join(",") +
      "] " +
      a.playState
    );
  });
}

const pct = (tri, p) => (tri.length ? tri[Math.min(tri.length - 1, Math.floor(tri.length * p))] : 0);
const arr1 = (x) => Math.round(x * 10) / 10;
const trier = (v) => [...v].sort((a, b) => a - b);
const resumerSerie = (v) => {
  const t = trier(v);
  return {
    n: t.length,
    mediane: arr1(pct(t, 0.5)),
    p95: arr1(pct(t, 0.95)),
    max: arr1(t[t.length - 1] ?? 0),
  };
};

/** Somme des durées et nombre d'événements du fil de rendu relevés dans une trace Chrome. */
function depouillerTrace(tampon) {
  const ev = JSON.parse(tampon.toString()).traceEvents;
  const noms = [
    "UpdateLayoutTree",
    "Layout",
    "PrePaint",
    "Paint",
    "Layerize",
    "Commit",
    "RasterTask",
    "FunctionCall",
    "EvaluateScript",
    "RunMicrotasks",
    "TimerFire",
    "FireAnimationFrame",
  ];
  const somme = Object.fromEntries(noms.map((n) => [n, { n: 0, ms: 0 }]));
  let forces = 0;
  for (const e of ev) {
    if (e.ph !== "X" || !Object.hasOwn(somme, e.name)) continue;
    somme[e.name].n++;
    somme[e.name].ms += (e.dur ?? 0) / 1000;
    if (e.name === "Layout" && e.args?.beginData?.stackTrace?.length) forces++;
  }
  for (const k of noms) somme[k].ms = Math.round(somme[k].ms);
  return { ...somme, layoutsForces: forces };
}

/** Écarts entre deux mises à jour du texte affiché pendant lesquels du texte reçu attend (longueur rendue du texte reçu interpolée entre les repères). */
function ecartsEnAttente(flux, recu, ancres) {
  const conv = (n) => {
    let i = 0;
    while (i + 1 < ancres.length && ancres[i + 1][0] <= n) i++;
    const [b0, r0] = ancres[i];
    const [b1, r1] = ancres[Math.min(i + 1, ancres.length - 1)];
    return b1 === b0 ? r0 : r0 + ((n - b0) * (r1 - r0)) / (b1 - b0);
  };
  let j = 0;
  let brut = 0;
  const attente = flux.map((t) => {
    while (j < recu.length && recu[j][0] <= t[0]) brut = recu[j++][1];
    return conv(brut) - t[1];
  });
  const ecarts = [];
  let derniere = -1;
  for (let i = 1; i < flux.length; i++) {
    if (flux[i][1] === flux[i - 1][1]) continue;
    if (derniere >= 0 && attente[derniere] > TOLERANCE_ATTENTE && attente[i - 1] > TOLERANCE_ATTENTE)
      ecarts.push(flux[i][0] - flux[derniere][0]);
    derniere = i;
  }
  return ecarts;
}

/** Résultat d'une passe à partir des relevés de la page. */
function analyser(
  fl,
  {
    reperes,
    texte,
    remonter,
    reducedMotion,
    resume,
    avantFin,
    apresFin,
    remontee,
    frappe,
    animations,
    trace,
    erreurs,
  },
) {
  const rel = (v) => (v ? Math.round(v - fl.envoiA) : null);
  // Délai repère reçu → repère affiché.
  const delais = trier(
    Object.keys(fl.arr)
      .filter((k) => k in fl.vis)
      .map((k) => fl.vis[k] - fl.arr[k]),
  );
  // Cadence : images où le texte affiché a changé, pendant le flux.
  const flux = fl.trames.filter((t) => t[5] === 1);
  const maj = [];
  const pas = [];
  for (let i = 1; i < flux.length; i++)
    if (flux[i][1] !== flux[i - 1][1]) {
      maj.push(flux[i][0]);
      pas.push(flux[i][1] - flux[i - 1][1]);
    }
  const ecarts = trier(maj.slice(1).map((t, i) => t - maj[i]));
  const pasTri = trier(pas.filter((p) => p > 0));
  const dureeFlux = flux.length ? (flux[flux.length - 1][0] - flux[0][0]) / 1000 : 0;
  // Repères d'interpolation : (position dans le texte reçu, position dans le texte affiché).
  const ancres = [[0, 0]];
  for (const k of Object.keys(fl.pos)) ancres.push([texte.indexOf("zq" + k) + 5, fl.pos[k]]);
  ancres.push([texte.length, flux.length ? flux[flux.length - 1][1] : 0]);
  // Suivi du bas : écart au bas peint, reculs et sauts de défilement. Hors mouvement réduit, une image en retard d'au plus
  // ECART_GLISSE_PX dont le défilement avance est le glissé vers le nouveau bas ; hors du bas = immobile loin du bas, ou trop loin.
  const suivis = remonter ? [] : flux.filter((t) => t[3] >= 0);
  const ecartsBas = trier(suivis.map((t) => t[3]));
  const glisse = (t, i) =>
    reducedMotion !== "reduce" && i > 0 && t[3] <= ECART_GLISSE_PX && t[2] > suivis[i - 1][2];
  const horsBas = suivis.filter((t, i) => t[3] > 4 && !glisse(t, i)).length;
  const glisses = trier(suivis.filter((t, i) => t[3] > 4 && glisse(t, i)).map((t) => t[3]));
  const marges = trier(suivis.map((t) => t[6]).filter((m) => typeof m === "number"));
  let reculs = 0;
  const sauts = [];
  for (let i = 1; i < suivis.length; i++) {
    const d = suivis[i][2] - suivis[i - 1][2];
    if (d < 0) reculs++;
    if (d > 0) sauts.push(d);
  }
  sauts.sort((a, b) => a - b);
  // Fin du flux : tâches longues et hauteur du corps autour de l'événement final.
  const ltFin = fl.lt.filter(([debut, duree]) => debut + duree >= fl.finalA && debut <= fl.finalA + 2500);
  const apresFinal = fl.trames.filter((t) => t[0] >= fl.finalA);
  const hauteurs = apresFinal.map((t) => t[4]);
  const avantFinal = fl.trames.filter((t) => t[0] < fl.finalA);
  const hAvant = avantFinal.length ? avantFinal[avantFinal.length - 1][4] : 0;
  const autourFin = fl.trames.filter((t) => t[0] >= fl.finalA - 150 && t[0] <= fl.finalA + 2500);
  const imagesFin = autourFin.map((t, i, a) => (i ? t[0] - a[i - 1][0] : 0));
  // Décalage des blocs repères et structure : l'état juste avant la fin de tour est un préfixe de l'état final.
  const decal = [];
  if (avantFin && apresFin)
    for (let i = 0; i < Math.min(avantFin.ancres.length, apresFin.ancres.length); i++)
      if (avantFin.ancres[i][0] === apresFin.ancres[i][0])
        decal.push(apresFin.ancres[i][1] - avantFin.ancres[i][1]);
  const structureIdentique =
    !!(avantFin && apresFin) &&
    avantFin.etiquettes.length <= apresFin.etiquettes.length &&
    avantFin.etiquettes.every((e, i) => e === apresFin.etiquettes[i]);
  return {
    premierJetonMs: Math.round(Math.min(...Object.values(fl.vis)) - fl.envoiA),
    delaiMs: resumerSerie(delais),
    cadence: {
      majParS: arr1(maj.length / (dureeFlux || 1)),
      ecartMedianMs: arr1(pct(ecarts, 0.5)),
      ecartP95Ms: arr1(pct(ecarts, 0.95)),
      caracteresParMaj: {
        mediane: pct(pasTri, 0.5),
        p95: pct(pasTri, 0.95),
        max: pasTri[pasTri.length - 1] ?? 0,
      },
      ecartEnAttenteMs: resumerSerie(ecartsEnAttente(flux, fl.recu, ancres)),
    },
    suiviBas: {
      images: suivis.length,
      horsBas,
      horsBasPct: arr1((100 * horsBas) / (ecartsBas.length || 1)),
      glisse: { images: glisses.length, ecartMax: glisses[glisses.length - 1] ?? 0 },
      margeCurseurMin: marges.length ? marges[0] : null,
      ecartP95: pct(ecartsBas, 0.95),
      ecartMax: ecartsBas[ecartsBas.length - 1] ?? 0,
      reculs,
      sautMedian: pct(sauts, 0.5),
      sautMax: sauts[sauts.length - 1] ?? 0,
      imagesAvecSaut: sauts.length,
    },
    fin: {
      finalRecu: fl.finalA > 0,
      termine: !!apresFin && !apresFin.flux,
      tachesLongues: ltFin.map(([, d]) => d),
      pireImageMs: Math.round(Math.max(0, ...imagesFin)),
      hauteurAvant: hAvant,
      hauteurApres: hauteurs[hauteurs.length - 1] ?? 0,
      changementsHauteur: hauteurs.filter((v, i) => i && v !== hauteurs[i - 1]).length,
      etiquettesFlux: avantFin?.etiquettes.join(" "),
      etiquettesFinal: apresFin?.etiquettes.join(" "),
      structureIdentique,
      noeuds: [avantFin?.noeuds, apresFin?.noeuds],
      decalageBlocs: decal,
      decalageMax: Math.max(0, ...decal.map(Math.abs)),
    },
    remontee,
    frappe,
    envoi: {
      bulleUser: rel(fl.jalons.bulleUser),
      creationChat: [rel(fl.jalons.creationDebut), rel(fl.jalons.creationFin)],
      bulleAssistant: rel(fl.jalons.bulleAssistant),
      indicateur: rel(fl.jalons.indicateur),
      requeteFlux: rel(fl.jalons.requete),
      entetes: rel(fl.jalons.entetes),
      texte: rel(fl.jalons.texte),
      evenements: Object.fromEntries(
        Object.entries(fl.types).map(([k, v]) => [k, Math.round(v - fl.envoiA)]),
      ),
    },
    balisageBrut: fl.brut,
    animations: Object.entries(animations.reduce((m, a) => ((m[a] = (m[a] || 0) + 1), m), {})).map(
      ([a, n]) => n + "× " + a,
    ),
    global: { fps: resume.fps, longTasks: resume.longTasks, cdp: resume.cdp, cls: resume.cls },
    reperes,
    trace,
    erreurs,
  };
}

/** Démarre le vrai cœur d'un arbre (faux moteur, clé de coffre et journal jetables) et ouvre la session d'un compte. */
export async function ouvrirBanc({ arbre = DEPOT } = {}) {
  const { demarrerCoreReel, Client, attendreMontage } = await import(
    pathToFileURL(path.join(arbre, "tests/frontend/lib/core-reel.mjs")).href
  );
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "banc-fluidite-"));
  // Jamais la clé de la machine : celle de l'environnement si elle est donnée, sinon une clé jetable.
  let cle = process.env.ELPIS_VAULT_KEY_PATH;
  if (!cle) {
    cle = path.join(dossier, "coffre.key");
    fs.writeFileSync(cle, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const core = await demarrerCoreReel({
    outilsEnProcessus: true,
    envSup: {
      ELPIS_VAULT_KEY_PATH: cle,
      ELPIS_AUDIT_KEY_PATH: process.env.ELPIS_AUDIT_KEY_PATH || "/nonexistent",
    },
  });
  try {
    const session = new Client(core.urlMain);
    await session.req("POST", "/api/login-lite", core.comptes.user);
    const { texte, reperes } = reponseMixte();
    return {
      core,
      session,
      texte,
      reperes,
      attendreMontage,
      Client,
      arreter: async () => {
        await core.arreter();
        fs.rmSync(dossier, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await core.arreter();
    fs.rmSync(dossier, { recursive: true, force: true });
    throw e;
  }
}

/** Ouvre le navigateur, la session et l'application, et attend le montage. */
async function ouvrirPage(banc, { reducedMotion, cpuRate }, burst) {
  const h = await launch({ reducedMotion, cpuRate });
  const { hostname } = new URL(banc.core.urlMain);
  await h.ctx.addCookies(
    [...banc.session.cookies].map(([name, value]) => ({ name, value, domain: hostname, path: "/" })),
  );
  if (burst !== null) await h.page.addInitScript(instrumenter, burst);
  await h.page.goto(banc.core.urlMain + "/");
  await banc.attendreMontage(h.page, 60000);
  await h.page.waitForTimeout(2500);
  return h;
}

/** Envoie un message depuis le composeur. */
async function envoyer(page, message) {
  await page.locator(SAISIE).last().fill(message);
  await page.locator(ENVOYER).last().click();
}

/** Attend que le bouton d'arrêt paraisse (entrée en flux) ou disparaisse (fin du tour). */
async function attendreFlux(page, present, timeout) {
  await page.waitForFunction(([s, p]) => !!document.querySelector(s) === p, [ARRET, present], {
    timeout,
    polling: 50,
  });
}

/** Une passe de mesure sur le banc ouvert ; renvoie le résultat détaillé (JSON). */
export async function mesureUne(banc, params = {}) {
  const {
    cpuRate = 4,
    toks = 60,
    reducedMotion = "reduce",
    burst = 0,
    pensee = false,
    remonter = false,
    frappe = false,
    suite = false,
    trace = false,
    skin = "",
  } = params;
  const { core, texte, reperes } = banc;
  core.llm.etat.file.length = 0;
  if (skin) await banc.session.req("POST", "/api/settings", { skin });
  if (suite) core.llm.scripter({ contenu: "Bien reçu.", tokParS: toks });
  core.llm.scripter({ contenu: texte, ...(pensee ? { raisonnement: REFLEXION } : {}), tokParS: toks });
  const h = await ouvrirPage(banc, { reducedMotion, cpuRate }, burst);
  try {
    if (suite) {
      await envoyer(h.page, "Bonjour");
      await attendreFlux(h.page, true, 15000);
      await attendreFlux(h.page, false, 60000);
      await h.page.waitForTimeout(1500);
      await h.page.evaluate(() => {
        Object.assign(window.__fl, {
          texteRecu: "",
          arr: {},
          recu: [],
          jalons: {},
          types: {},
          finalA: 0,
          avantFinal: null,
        });
      });
    }
    const fen = await startWindow(h.page, h.cdp, { frames: true });
    if (trace)
      await h.browser.startTracing(h.page, {
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.stack",
        ],
      });
    await h.page.evaluate(demarrerEchantillonneur, reperes);
    await h.page.locator(SAISIE).last().fill("Décris le pipeline de mesure, avec un exemple.");
    await h.page.evaluate(() => (window.__fl.envoiA = performance.now()));
    await h.page.locator(ENVOYER).last().click();
    await attendreFlux(h.page, true, 15000);
    const reperesVus = (n) =>
      h.page.waitForFunction((k) => Object.keys(window.__fl.vis).length >= k, n, {
        timeout: 60000,
        polling: 100,
      });
    await reperesVus(10);
    const animations = await h.page.evaluate(lireAnimations);
    let mesFrappe = null;
    if (frappe) {
      // Saisie dans le composeur pendant le flux : durée des événements clavier (jusqu'à la peinture suivante).
      await h.page.evaluate(() => (window.__perf.ev = []));
      await h.page.locator(SAISIE).last().click();
      await h.page.keyboard.type("Une question tapée pendant que la réponse arrive, assez longue.", {
        delay: 70,
      });
      await h.page.waitForTimeout(300);
      const ev = await h.page.evaluate(() =>
        window.__perf.ev.filter(([n]) => n === "keydown" || n === "input" || n === "keypress"),
      );
      const d = trier(ev.map(([, duree]) => duree));
      mesFrappe = { n: d.length, mediane: pct(d, 0.5), p95: pct(d, 0.95), max: d[d.length - 1] ?? 0 };
    }
    let remontee = null;
    if (remonter) {
      // L'utilisateur remonte au milieu du flux : rien ne doit le ramener en bas.
      await reperesVus(14);
      await h.page.mouse.move(700, 400);
      await h.page.mouse.wheel(0, -600);
      await h.page.waitForTimeout(400);
      const position = () =>
        h.page.evaluate(() => document.querySelector(".elpis-chat-col").parentElement.scrollTop);
      const avant = await position();
      await h.page.waitForTimeout(3000);
      const apres = await position();
      remontee = { avant, apres, ramene: apres > avant + 2 };
    }
    await attendreFlux(h.page, false, 180000);
    await h.page.waitForTimeout(2500);
    const apresFin = await h.page.evaluate(() => window.__fl.structure());
    const brutTrace = trace ? depouillerTrace(await h.browser.stopTracing()) : null;
    const resume = await stopWindow(h.page, h.cdp, fen);
    const fl = await h.page.evaluate(() => {
      cancelAnimationFrame(window.__fl._raf);
      const { arr, vis, pos, trames, recu, finalA, envoiA, jalons, types, brut, avantFinal } = window.__fl;
      return {
        arr,
        vis,
        pos,
        trames,
        recu,
        finalA,
        envoiA,
        jalons,
        types,
        brut,
        avantFinal,
        lt: window.__perf.lt,
      };
    });
    return analyser(fl, {
      reperes,
      texte,
      remonter,
      reducedMotion,
      resume,
      avantFin: fl.avantFinal,
      apresFin,
      remontee,
      frappe: mesFrappe,
      animations,
      trace: brutTrace,
      erreurs: h.errors,
    });
  } finally {
    await h.browser.close();
  }
}

/** Passe sans échantillonneur : coût du fil principal pendant une fenêtre du milieu du flux (CDP seul), l'échantillonneur par image n'y ajoute rien. */
export async function mesureCout(banc, params = {}) {
  const { cpuRate = 4, toks = 60, reducedMotion = "reduce", pensee = false, fenetreS = 12 } = params;
  const { core, texte } = banc;
  core.llm.etat.file.length = 0;
  // Réponse répétée (≈ 1 300 jetons) pour que le flux couvre la fenêtre, ses 3 s d'attente et 2 s de marge.
  const copies = Math.max(1, Math.ceil(((5 + fenetreS) * toks) / 1300));
  core.llm.scripter({
    contenu: Array(copies).fill(texte).join("\n"),
    ...(pensee ? { raisonnement: REFLEXION } : {}),
    tokParS: toks,
  });
  const h = await ouvrirPage(banc, { reducedMotion, cpuRate }, null);
  try {
    const metriques = async () =>
      Object.fromEntries(
        (await h.cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
      );
    await envoyer(h.page, "Décris le pipeline de mesure, avec un exemple.");
    await attendreFlux(h.page, true, 15000);
    await h.page.waitForTimeout(3000);
    const m0 = await metriques();
    await h.page.waitForTimeout(fenetreS * 1000);
    const m1 = await metriques();
    const d = (k) => Math.round((m1[k] - m0[k]) * 100) / 100;
    await h.page
      .locator(ARRET)
      .click()
      .catch(() => {});
    await h.page.waitForTimeout(500);
    return {
      mode: "cout",
      fenetreS,
      tachesS: d("TaskDuration"),
      scriptS: d("ScriptDuration"),
      styleS: d("RecalcStyleDuration"),
      layoutS: d("LayoutDuration"),
      erreurs: h.errors,
    };
  } finally {
    await h.browser.close();
  }
}

/** Passe unique, banc ouvert puis refermé : même signature que les autres scénarios. */
export async function run(params = {}) {
  const banc = await ouvrirBanc({ arbre: params.arbre });
  try {
    return params.sansEchantillonneur ? await mesureCout(banc, params) : await mesureUne(banc, params);
  } finally {
    await banc.arreter();
  }
}

/** Cibles du plan (section 3) tenues ou non par une passe ; seules les cibles applicables aux paramètres de la passe y figurent. */
export function verdict(r, params = {}) {
  const { toks = 60, burst = 0, remonter = false, frappe = false, reducedMotion = "reduce" } = params;
  const rapide = toks >= 150;
  const lignes = [];
  const cible = (nom, ok, valeur, attendu) => lignes.push({ nom, ok: !!ok, valeur, attendu });
  const fps = r.global.fps || { mean: 0, droppedPct: 1 };
  cible(
    "fin de tour valide (message terminé)",
    r.fin.finalRecu && r.fin.termine,
    `${r.fin.finalRecu}/${r.fin.termine}`,
    "true/true",
  );
  cible(
    "mises à jour par seconde",
    r.cadence.majParS >= (rapide ? 30 : 40),
    r.cadence.majParS,
    rapide ? "≥ 30" : "≥ 40",
  );
  cible(
    "caractères par mise à jour, p95",
    r.cadence.caracteresParMaj.p95 <= (rapide ? 12 : 6),
    r.cadence.caracteresParMaj.p95,
    rapide ? "≤ 12" : "≤ 6",
  );
  if (burst === 0) {
    cible("reçu → affiché, médiane", r.delaiMs.mediane <= 35, r.delaiMs.mediane, "≤ 35 ms");
    cible("reçu → affiché, p95", r.delaiMs.p95 <= 70, r.delaiMs.p95, "≤ 70 ms");
  } else
    cible(
      "écart entre deux mises à jour tant que du texte attend, p95",
      r.cadence.ecartEnAttenteMs.p95 <= 50,
      `${r.cadence.ecartEnAttenteMs.p95} (n=${r.cadence.ecartEnAttenteMs.n})`,
      "≤ 50 ms",
    );
  if (!remonter) {
    cible(
      reducedMotion === "reduce"
        ? "images à plus de 4 px du bas"
        : `images hors du bas (immobiles à plus de 4 px, ou à plus de ${ECART_GLISSE_PX} px)`,
      r.suiviBas.horsBas === 0,
      r.suiviBas.horsBas,
      "0",
    );
    cible("reculs du défilement", r.suiviBas.reculs === 0, r.suiviBas.reculs, "0");
    cible(
      "dernier texte affiché au-dessus du composeur, marge minimale",
      r.suiviBas.margeCurseurMin === null || r.suiviBas.margeCurseurMin >= 0,
      `${r.suiviBas.margeCurseurMin} px`,
      "≥ 0 px",
    );
  } else
    cible(
      "l'utilisateur remonté n'est pas ramené en bas",
      r.remontee && !r.remontee.ramene,
      r.remontee && r.remontee.ramene,
      "false",
    );
  cible("images par seconde", fps.mean >= 57, fps.mean, "≥ 57");
  cible(
    "images de plus de 25 ms",
    fps.droppedPct <= 0.02,
    `${Math.round(fps.droppedPct * 1000) / 10} %`,
    "≤ 2 %",
  );
  const brut = r.balisageBrut;
  cible(
    "images avec balisage brut (**, accent, marqueur seul)",
    brut.gras + brut.accent + brut.marqueur === 0,
    `${brut.gras}/${brut.accent}/${brut.marqueur}`,
    "0/0/0",
  );
  const maxFin = Math.max(0, ...r.fin.tachesLongues);
  cible("tâche longue autour de la fin de tour", maxFin <= 50, `${maxFin} ms`, "≤ 50 ms");
  cible(
    "décalage des blocs déjà affichés à la fin",
    r.fin.decalageMax <= 1,
    `${r.fin.decalageMax} px`,
    "0 px (1 px de tolérance d'arrondi)",
  );
  cible(
    "structure de premier niveau identique avant et après la fin",
    r.fin.structureIdentique,
    r.fin.structureIdentique,
    "true",
  );
  if (frappe)
    cible(
      "frappe → peinture pendant le flux, p95",
      r.frappe && r.frappe.p95 <= 48,
      r.frappe && `${r.frappe.p95} ms (${r.frappe.n} lents)`,
      "≤ 48 ms",
    );
  cible("aucune erreur de page", r.erreurs.length === 0, r.erreurs.length, "0");
  return lignes;
}

/** Ligne de résumé d'une passe. */
export function ligneResume(r) {
  const f = r.global.fps;
  return (
    `1er jeton ${r.premierJetonMs} ms | délai méd ${r.delaiMs.mediane} p95 ${r.delaiMs.p95} | ${r.cadence.majParS} maj/s, ${r.cadence.caracteresParMaj.mediane} car./maj (p95 ${r.cadence.caracteresParMaj.p95})` +
    ` | hors bas ${r.suiviBas.horsBasPct} %, glissé ${r.suiviBas.glisse.images} img (≤ ${r.suiviBas.glisse.ecartMax} px), caret ≥ ${r.suiviBas.margeCurseurMin} px, reculs ${r.suiviBas.reculs} | fin : LT ${JSON.stringify(r.fin.tachesLongues)}, pire image ${r.fin.pireImageMs} ms, h ${r.fin.hauteurAvant}→${r.fin.hauteurApres}, décalage ${r.fin.decalageMax} px` +
    ` | fps ${f?.mean} perdues ${f?.droppedPct} | tâches ${r.global.cdp.TaskDuration} s`
  );
}
