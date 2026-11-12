// SPDX-License-Identifier: MIT
/** tests/frontend/stream-fluidity-verify.mjs — lanceur du scénario k_stream_fluidite : passes de mesure du flux sur le vrai cœur, résumé, JSON par passe, verdict contre les cibles du plan, comparaison de deux arbres */
// Recette (Node 24, front et cœur construits : npm run build -w @elpis/web ; ELPIS_NODE_MODULES = node_modules qui contient Playwright) :
//   node tests/frontend/stream-fluidity-verify.mjs --label base --cpu 4 --runs 2
//   node tests/frontend/stream-fluidity-verify.mjs --label lot2 --cpu 4 --runs 3 --ref /chemin/arbre-de-reference --verdict
//
// Options : --cpu N (ralentissement du processeur, 4) · --toks N (jetons/s, 60) · --rm reduce|no-preference (reduce)
//   --burst MS (le flux est relâché toutes les MS par une enveloppe de fetch, 0) · --pensee (phase de réflexion avant la réponse)
//   --remonter (l'utilisateur remonte au milieu du flux) · --frappe (l'utilisateur tape pendant le flux) · --suite (mesure le 2e message)
//   --runs N (passes, 2) · --label NOM (dossier tests/perf/results/NOM) · --skin NOM · --trace (décompte des phases de rendu)
//   --arbre CHEMIN (arbre mesuré, par défaut celui du lanceur) · --ref CHEMIN (arbre de référence : passes alternées référence/candidat)
//   --sans-echantillonneur [--fenetre S] (coût du fil principal sur S secondes du milieu du flux, sans lecture par image)
//   --verdict (code de sortie non nul si une cible du plan n'est pas tenue ; sans effet avec --sans-echantillonneur) · --tache-max R (avec --ref : tâches du candidat ≤ R × référence)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ligneResume,
  mesureCout,
  mesureUne,
  ouvrirBanc,
  verdict,
} from "../perf/scenarios/k_stream_fluidite.mjs";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (nom, defaut) => {
  const i = args.indexOf("--" + nom);
  if (i === -1) return defaut;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const label = arg("label");
if (!label || label === true) {
  console.error("--label requis (ex : --label base)");
  process.exit(2);
}
const params = {
  cpuRate: Number(arg("cpu", 4)),
  toks: Number(arg("toks", 60)),
  reducedMotion: String(arg("rm", "reduce")),
  burst: Number(arg("burst", 0)),
  pensee: !!arg("pensee", false),
  remonter: !!arg("remonter", false),
  frappe: !!arg("frappe", false),
  suite: !!arg("suite", false),
  trace: !!arg("trace", false),
  skin: String(arg("skin", "")),
  fenetreS: Number(arg("fenetre", 12)),
};
const runs = Number(arg("runs", 2));
const sansEchantillonneur = !!arg("sans-echantillonneur", false);
const veutVerdict = !!arg("verdict", false);
const tacheMax = Number(arg("tache-max", 0));
const arbre = path.resolve(String(arg("arbre", DEPOT)));
const ref = arg("ref", null) ? path.resolve(String(arg("ref"))) : null;

const cle =
  `cpu${params.cpuRate}_toks${params.toks}_burst${params.burst}_${params.reducedMotion === "reduce" ? "reduce" : "nopref"}` +
  `${params.remonter ? "_remonter" : ""}${params.frappe ? "_frappe" : ""}${params.suite ? "_suite" : ""}${params.pensee ? "_pensee" : ""}` +
  `${params.trace ? "_trace" : ""}${sansEchantillonneur ? "_cout" : ""}`;
const sortie = path.join(DEPOT, "tests/perf/results", String(label));
fs.mkdirSync(sortie, { recursive: true });

const commitDe = (dossier) => {
  try {
    const sh = (c) =>
      execSync(c, { cwd: dossier, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    return {
      commit: sh("git rev-parse --short HEAD"),
      frontModifie: sh("git status --porcelain frontend") !== "",
    };
  } catch {
    return null;
  }
};
const mediane = (v) => {
  const t = v.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return t.length ? t[t.length >> 1] : null;
};

// Côtés mesurés : la référence (si donnée) puis le candidat, passe après passe.
const cotes = [...(ref ? [{ nom: "ref", arbre: ref }] : []), { nom: ref ? "cand" : "", arbre }];
for (const c of cotes) {
  c.banc = await ouvrirBanc({ arbre: c.arbre });
  c.resultats = [];
}
fs.writeFileSync(
  path.join(sortie, `_meta_${cle}.json`),
  JSON.stringify(
    {
      label,
      cle,
      params,
      ts: new Date().toISOString(),
      node: process.version,
      chromium: process.env.ELPIS_CHROMIUM || "playwright (channel chromium)",
      arbres: cotes.map((c) => ({ cote: c.nom || "cand", ...commitDe(c.arbre) })),
      machine: {
        nproc: os.cpus().length,
        ramGo: Math.round(os.totalmem() / 1073741824),
        chargeDebut: os.loadavg(),
      },
    },
    null,
    1,
  ),
);

let echecs = 0;
let manques = 0;
try {
  for (let i = 1; i <= runs; i++) {
    for (const c of cotes) {
      const nom = `${cle}${c.nom ? " " + c.nom : ""} p${i}`;
      let r;
      try {
        r = await (sansEchantillonneur ? mesureCout : mesureUne)(c.banc, params);
      } catch (e) {
        echecs++;
        console.log(`${nom} : ÉCHEC ${String(e.message).split("\n")[0]}`);
        continue;
      }
      c.resultats.push(r);
      const cibles = veutVerdict && c.nom !== "ref" && !sansEchantillonneur ? verdict(r, params) : null;
      fs.writeFileSync(
        path.join(sortie, `${cle}${c.nom ? "_" + c.nom : ""}_p${i}.json`),
        JSON.stringify({ cle, cote: c.nom, passe: i, params, ...r, verdict: cibles }, null, 1),
      );
      if (sansEchantillonneur) {
        console.log(
          `${nom} : tâches ${r.tachesS} s / ${r.fenetreS} s | script ${r.scriptS} | style ${r.styleS} | layout ${r.layoutS} | erreurs ${r.erreurs.length}`,
        );
        continue;
      }
      console.log(`  animations ${JSON.stringify(r.animations)}`);
      console.log(
        `  envoi ${JSON.stringify(r.envoi)} | brut ${JSON.stringify(r.balisageBrut)} | frappe ${JSON.stringify(r.frappe)}`,
      );
      console.log(`${nom} : ${ligneResume(r)}`);
      for (const l of cibles ?? []) {
        if (!l.ok) manques++;
        console.log(`    ${l.ok ? "✓" : "✗"} ${l.nom} : ${l.valeur} (cible ${l.attendu})`);
      }
    }
  }
} finally {
  for (const c of cotes) await c.banc.arreter();
}

if (ref && !sansEchantillonneur) {
  // Médianes des passes, côté par côté : le candidat se juge contre la référence mesurée à côté, pas contre un chiffre d'un autre jour.
  const lignes = [
    ["mises à jour/s", (r) => r.cadence.majParS],
    ["car./maj p95", (r) => r.cadence.caracteresParMaj.p95],
    ["délai médian ms", (r) => r.delaiMs.mediane],
    ["délai p95 ms", (r) => r.delaiMs.p95],
    ["images hors bas", (r) => r.suiviBas.horsBas],
    ["tâche longue max ms", (r) => Math.max(0, ...r.fin.tachesLongues)],
    ["décalage blocs px", (r) => r.fin.decalageMax],
    ["fps", (r) => r.global.fps?.mean],
    ["tâches du fil s", (r) => r.global.cdp.TaskDuration],
  ];
  console.log(`\n${"médiane des passes".padEnd(22)}${"réf".padStart(10)}${"cand".padStart(10)}`);
  for (const [nom, f] of lignes)
    console.log(
      `${nom.padEnd(22)}${String(mediane(cotes[0].resultats.map(f))).padStart(10)}${String(mediane(cotes[1].resultats.map(f))).padStart(10)}`,
    );
}
if (ref && tacheMax > 0) {
  const t = (c) =>
    mediane(c.resultats.map((r) => (sansEchantillonneur ? r.tachesS : r.global.cdp.TaskDuration)));
  const rapport = t(cotes[1]) / (t(cotes[0]) || 1);
  const tenu = rapport <= tacheMax;
  console.log(
    `\n${tenu ? "✓" : "✗"} tâches du fil principal : candidat / référence = ${Math.round(rapport * 100) / 100} (cible ≤ ${tacheMax})`,
  );
  if (!tenu) manques++;
}
console.log(
  `\nRésultats : ${sortie}${echecs ? `  (${echecs} passe(s) en échec)` : ""}${veutVerdict ? `  (${manques} cible(s) manquée(s))` : ""}`,
);
process.exit(echecs || (veutVerdict && manques) ? 1 : 0);
