// SPDX-License-Identifier: MIT
/** tests/frontend/app-fluidity-verify.mjs — lanceur du scénario l_app_fluidite : passes de mesure de chaque geste de l'application sur le vrai cœur, médianes, classement, profil des gestes les plus lents, comparaison de deux arbres */
// Recette (Node 24, front et cœur construits ; ELPIS_NODE_MODULES = node_modules qui contient Playwright) :
//   node tests/frontend/app-fluidity-verify.mjs --label base --cpu 4 --runs 2
//   node tests/frontend/app-fluidity-verify.mjs --label base --arbre /chemin/arbre --cpu 4 --runs 2 --profil 8 --cartes /chemin/cartes
//   node tests/frontend/app-fluidity-verify.mjs --label lot --ref /chemin/reference --cpu 4 --runs 3 --filtre "volet|Paramètres"
//
// Options : --cpu N (ralentissement du processeur, 4) · --runs N (passes, 2) · --label NOM (dossier de sortie, requis)
//   --sortie DOSSIER (racine des résultats, tests/perf/results par défaut) · --filtre REGEX (gestes gardés, sur le nom)
//   --arbre CHEMIN (arbre mesuré, par défaut celui du lanceur) · --ref CHEMIN (arbre de référence : passes alternées)
//   --rm no-preference|reduce (préférence de mouvement, no-preference) · --liste (affiche les gestes et sort)
//   --profil [N] (après les passes, profil des N gestes les plus lents, 8 ; avec --filtre et --runs 0 : des gestes filtrés)
//   --cartes DOSSIER (cartes de sources d'un build à part de l'arbre mesuré, pour nommer les fonctions du profil) :
//     (cd ARBRE/frontend && npx vite build --sourcemap --outDir DOSSIER --emptyOutDir)
//   --profil-filtre REGEX (profil des gestes dont le nom correspond, au lieu des plus lents)
//   --garder-profils (écrit aussi les .cpuprofile bruts) · --resumer (refait résumé et tableau à partir des passes déjà écrites, sans mesurer)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classer,
  ouvrirBanc,
  passe,
  profiler,
  resumer,
  SEUILS,
  tableau,
} from "../perf/scenarios/l_app_fluidite.mjs";
import { listeGestes } from "../perf/scenarios/l_app_gestes.mjs";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (nom, defaut) => {
  const i = args.indexOf("--" + nom);
  if (i === -1) return defaut;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
if (arg("liste", false)) {
  for (const g of await listeGestes())
    console.log(
      `${g.groupe.padEnd(12)} ${g.nom.padEnd(48)} ${g.selecteur || ""}${g.nonMesure ? `  [non mesuré : ${g.nonMesure}]` : ""}`,
    );
  process.exit(0);
}
const label = arg("label");
if (!label || label === true) {
  console.error("--label requis (ex : --label base)");
  process.exit(2);
}
const params = {
  cpuRate: Number(arg("cpu", 4)),
  rm: String(arg("rm", "no-preference")),
  filtre: arg("filtre", "") === true ? "" : String(arg("filtre", "")),
};
const runs = Number(arg("runs", 2));
const profilArg = arg("profil", null);
const profilFiltre = arg("profil-filtre", null);
const nProfil = profilFiltre ? 1 : profilArg === null ? 0 : profilArg === true ? 8 : Number(profilArg);
const cartes = arg("cartes", null) ? path.resolve(String(arg("cartes"))) : null;
const arbre = path.resolve(String(arg("arbre", DEPOT)));
const ref = arg("ref", null) ? path.resolve(String(arg("ref"))) : null;
const cle = `cpu${params.cpuRate}${params.rm === "reduce" ? "_reduce" : ""}`;
const sortie = path.join(
  path.resolve(String(arg("sortie", path.join(DEPOT, "tests/perf/results")))),
  String(label),
);
fs.mkdirSync(sortie, { recursive: true });

const commitDe = (dossier) => {
  try {
    const sh = (c) =>
      execSync(c, { cwd: dossier, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    return {
      commit: sh("git rev-parse --short HEAD"),
      branche: sh("git rev-parse --abbrev-ref HEAD"),
      frontModifie: sh("git status --porcelain frontend") !== "",
    };
  } catch {
    return null;
  }
};

if (arg("resumer", false)) {
  // Résumé seul : passes du dossier de sortie pour cette cadence, par côté.
  for (const cote of ["", "_ref", "_cand"]) {
    const re = new RegExp(`^${cle}${cote}_p\\d+\\.json$`);
    const passes = fs
      .readdirSync(sortie)
      .filter((f) => re.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sortie, f), "utf8")).gestes);
    if (!passes.length) continue;
    const resume = resumer(passes);
    fs.writeFileSync(
      path.join(sortie, `resume_${cle}${cote}.json`),
      JSON.stringify(classer(resume), null, 1),
    );
    fs.writeFileSync(path.join(sortie, `tableau_${cle}${cote}.txt`), tableau(resume) + "\n");
    console.log(`${cle}${cote} : ${passes.length} passe(s) résumée(s)`);
  }
  process.exit(0);
}
const cotes = [...(ref ? [{ nom: "ref", arbre: ref }] : []), { nom: ref ? "cand" : "", arbre }];
// Tout ce que le banc lance (cœurs, faux serveurs, Chromium) s'arrête aussi sur échec d'ouverture ou sur signal.
const arreterTout = async () => {
  for (const c of cotes) await c.banc?.arreter().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void arreterTout().finally(() => process.exit(130)));
try {
  for (const c of cotes) {
    c.banc = await ouvrirBanc({ arbre: c.arbre });
    c.passes = [];
  }
} catch (e) {
  await arreterTout();
  throw e;
}
fs.writeFileSync(
  path.join(sortie, `_meta_${cle}.json`),
  JSON.stringify(
    {
      label,
      cle,
      params,
      runs,
      seuils: SEUILS,
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

const journal = (geste, r) => {
  const etat = r.nonMesure
    ? `non mesuré (${r.nonMesure})`
    : r.ok
      ? ""
      : `ÉCHEC ${r.erreur || "prédicat non atteint"}`;
  console.log(
    `  ${geste.nom.slice(0, 46).padEnd(47)} lat ${String(r.latence ?? "-").padStart(5)} · stable ${String(r.stableMs ?? "-").padStart(5)} · tâche ${String(r.taches?.maxMs ?? "-").padStart(4)} · img>33 ${String(r.images?.lentes ?? "-").padStart(2)} · décal ${r.decalage?.total ?? "-"} ${etat}`,
  );
};

let echecs = 0;
try {
  for (let i = 1; i <= runs; i++) {
    for (const c of cotes) {
      console.log(`\n== ${cle}${c.nom ? " " + c.nom : ""} passe ${i}`);
      const t0 = Date.now();
      const r = await passe(c.banc, { ...params, journal });
      c.passes.push(r);
      echecs += r.filter((g) => !g.ok && !g.nonMesure).length;
      fs.writeFileSync(
        path.join(sortie, `${cle}${c.nom ? "_" + c.nom : ""}_p${i}.json`),
        JSON.stringify(
          { cle, cote: c.nom, passe: i, params, dureeS: Math.round((Date.now() - t0) / 1000), gestes: r },
          null,
          1,
        ),
      );
    }
  }
  for (const c of cotes) {
    if (!c.passes.length) continue;
    c.resume = resumer(c.passes);
    const suffixe = c.nom ? "_" + c.nom : "";
    fs.writeFileSync(
      path.join(sortie, `resume_${cle}${suffixe}.json`),
      JSON.stringify(classer(c.resume), null, 1),
    );
    const texte = tableau(c.resume);
    fs.writeFileSync(path.join(sortie, `tableau_${cle}${suffixe}.txt`), texte + "\n");
    console.log(
      `\n${cle}${c.nom ? " " + c.nom : ""} — médianes de ${c.passes.length} passe(s), du plus lent au plus rapide (ms ; décal. = somme layout-shift)\n${texte}`,
    );
  }
  if (ref && cotes[0].resume && cotes[1].resume) {
    console.log(
      `\n${"geste".padEnd(48)}${"lat réf".padStart(9)}${"lat cand".padStart(9)}${"tâche réf".padStart(10)}${"tâche cand".padStart(11)}`,
    );
    for (const g of classer(cotes[1].resume)) {
      const a = cotes[0].resume.find((x) => x.nom === g.nom) || {};
      console.log(
        `${g.nom.slice(0, 47).padEnd(48)}${String(a.latence ?? "-").padStart(9)}${String(g.latence ?? "-").padStart(9)}${String(a.tacheMax ?? "-").padStart(10)}${String(g.tacheMax ?? "-").padStart(11)}`,
      );
    }
  }
  if (nProfil > 0) {
    const c = cotes[cotes.length - 1];
    // Gestes profilés : ceux de --profil-filtre, sinon les N plus lents mesurés, ou ceux du filtre si aucune passe n'a tourné.
    const noms = profilFiltre
      ? new RegExp(String(profilFiltre), "i")
      : c.resume
        ? classer(c.resume)
            .filter((g) => g.latence !== null && !g.nonMesure)
            .slice(0, nProfil)
            .map((g) => g.nom)
        : (await listeGestes())
            .filter((g) => !params.filtre || new RegExp(params.filtre, "i").test(g.nom))
            .slice(0, nProfil)
            .map((g) => g.nom);
    console.log(`\nProfil de : ${noms instanceof RegExp ? noms : noms.join(" · ")}`);
    const brut = arg("garder-profils", false) ? path.join(sortie, `profils_${cle}`) : null;
    const profils = await profiler(c.banc, params, noms, { cartes, garderBrut: brut });
    fs.writeFileSync(path.join(sortie, `profils_${cle}.json`), JSON.stringify(profils, null, 1));
    for (const p of profils) {
      console.log(`\n== ${p.nom}${p.erreur ? ` : ÉCHEC ${p.erreur}` : ""}`);
      if (p.erreur) continue;
      console.log(
        `   occupé ${p.occupeMs} ms · ${Object.entries(p.familles)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")} · tâches > 50 ms [${p.tachesLongues.join(", ")}]`,
      );
      for (const [ms, f] of p.fonctionsPropre.slice(0, 10))
        console.log(`   ${String(ms).padStart(7)} ms  ${f}`);
    }
  }
} finally {
  await arreterTout();
}
console.log(`\nRésultats : ${sortie}${echecs ? `  (${echecs} geste(s) en échec)` : ""}`);
process.exit(0);
