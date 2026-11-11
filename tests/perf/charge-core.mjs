// SPDX-License-Identifier: MIT
/** tests/perf/charge-core.mjs — test de charge du core seul (process main) contre le faux LLM : N flux simultanés par palier */
// Recette : node tests/perf/charge-core.mjs [--paliers 10,50,100,200,400] [--tok 40] [--jetons 300] [--par-compte 5]
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { Client, COMPTES, demarrerCoreReel } from "../frontend/lib/core-reel.mjs";

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(nom);
  return i > 0 ? process.argv[i + 1] : defaut;
};
const PALIERS = arg("--paliers", "10,50,100,200,400").split(",").map(Number);
const TOK = Number(arg("--tok", "40"));
const JETONS = Number(arg("--jetons", "300"));
const PAR_COMPTE = Number(arg("--par-compte", "5"));

const mediane = (t) => {
  const s = [...t].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const p95 = (t) => {
  const s = [...t].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
};

// Process du core lancé avec BIND=127.0.0.1:<port> (environnement lu dans /proc).
function pidDuPort(port) {
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`BIND=127.0.0.1:${port}`))
        return Number(d);
    } catch {
      /* process disparu ou illisible */
    }
  }
  throw new Error(`aucun process lié au port ${port}`);
}

// Temps CPU cumulé (ms) et RSS (Mo) d'un process, lus dans /proc.
function statProc(pid) {
  const champs = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const tic = 100;
  const cpuMs = ((Number(champs[11]) + Number(champs[12])) * 1000) / tic;
  const rss = (Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * 4096) / 1048576;
  return { cpuMs, rss };
}

// Un tour de chat complet : envoi, lecture du NDJSON jusqu'à la fin, mesures.
async function tour(client, chatId) {
  const t0 = performance.now();
  const r = await fetch(client.base + "/api/chat-saved-stream3", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Explique la charge, en détail." }],
      chat_id: chatId,
      resumable: true,
    }),
  });
  if (!r.ok) return { ok: false, statut: r.status, texte: (await r.text()).slice(0, 120) };
  const lecteur = r.body.getReader();
  const dec = new TextDecoder();
  let tampon = "";
  let premier = 0;
  let jetons = 0;
  let fin = false;
  let erreur = null;
  for (;;) {
    const { value, done } = await lecteur.read();
    if (done) break;
    tampon += dec.decode(value, { stream: true });
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, i).trim();
      tampon = tampon.slice(i + 1);
      if (!ligne) continue;
      let ev;
      try {
        ev = JSON.parse(ligne);
      } catch {
        continue;
      }
      if (ev.type === "content_token") {
        jetons++;
        if (!premier) premier = performance.now() - t0;
      }
      if (ev.type === "final") fin = true;
      if (ev.type === "error") erreur = ev.message || ev.error || "erreur";
    }
  }
  return { ok: fin && !erreur, statut: r.status, premier, total: performance.now() - t0, jetons, erreur };
}

const texte = Array.from({ length: Math.ceil(JETONS / 2) }, (_, i) => `mot${i % 97}`).join(" ");
const MAXF = Math.max(...PALIERS);
const env = await demarrerCoreReel({
  tokParS: TOK,
  fixtures: true,
  slots: MAXF,
  envSup: { LLAMA_MAX_CONCURRENCY: String(MAXF) },
});
env.llm.etat.parDefaut = texte;
const portMain = Number(new URL(env.urlMain).port);
const pid = pidDuPort(portMain);
const resultats = [];
try {
  const adminConsole = new Client(env.urlAdmin);
  await adminConsole.req("POST", "/api/login-lite", COMPTES.admin);
  const comptes = [];
  const besoin = Math.ceil(Math.max(...PALIERS) / PAR_COMPTE);
  for (let k = 0; k < besoin; k++) {
    const compte = { username: `charge${k}`, password: `Charge-mdp-${k}-0123456789` };
    await adminConsole.req("POST", "/api/admin/users/new", { ...compte, role: "user" });
    const c = new Client(env.urlMain);
    await c.req("POST", "/api/login-lite", compte);
    await c.req("POST", "/api/users/change-password", { new_password: compte.password });
    comptes.push(c);
  }
  process.stderr.write(`${comptes.length} comptes créés\n`);

  for (const n of PALIERS) {
    const chats = [];
    for (let i = 0; i < n; i++) {
      const c = comptes[i % comptes.length];
      const { id } = await c.req("POST", "/api/saved/chats/new", {});
      chats.push({ c, id });
    }
    env.llm.etat.requetes.length = 0;
    const sonde = new Client(env.urlMain);
    sonde.cookies = comptes[0].cookies;
    const latences = [];
    let actif = true;
    const boucleSonde = (async () => {
      while (actif) {
        const t = performance.now();
        await sonde.req("GET", "/api/me-lite").catch(() => null);
        latences.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const s0 = statProc(pid);
    const h0 = process.cpuUsage();
    const t0 = performance.now();
    const tours = await Promise.all(chats.map(({ c, id }) => tour(c, id)));
    const duree = performance.now() - t0;
    const s1 = statProc(pid);
    const h1 = process.cpuUsage(h0);
    actif = false;
    await boucleSonde;
    const ok = tours.filter((t) => t.ok);
    const ko = tours.filter((t) => !t.ok);
    const res = {
      flux: n,
      ok: ok.length,
      echecs: ko.length,
      premierJetonMed: Math.round(mediane(ok.map((t) => t.premier))),
      premierJetonP95: Math.round(p95(ok.map((t) => t.premier))),
      dureeMed: Math.round(mediane(ok.map((t) => t.total))),
      dureeP95: Math.round(p95(ok.map((t) => t.total))),
      jetonsMed: mediane(ok.map((t) => t.jetons)),
      sondeMed: Math.round(mediane(latences)),
      sondeP95: Math.round(p95(latences)),
      cpuCorePct: Math.round(((s1.cpuMs - s0.cpuMs) / duree) * 100),
      rssCoreMo: Math.round(s1.rss),
      cpuHarnaisPct: Math.round(((h1.user + h1.system) / 1000 / duree) * 100),
      exempleEchec: ko[0] ? `${ko[0].statut} ${ko[0].erreur || ko[0].texte || ""}`.slice(0, 120) : "",
    };
    resultats.push(res);
    process.stderr.write(JSON.stringify(res) + "\n");
  }
} finally {
  await env.arreter();
}
console.log(
  JSON.stringify(
    {
      tokParS: TOK,
      jetonsParReponse: JETONS,
      parCompte: PAR_COMPTE,
      nproc: Number(execFileSync("nproc", { encoding: "utf8" })),
      resultats,
    },
    null,
    1,
  ),
);
