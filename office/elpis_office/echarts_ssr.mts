// SPDX-License-Identifier: MIT
// office/elpis_office/echarts_ssr.mts — rendu des graphiques côté serveur.
//
// Entrée (stdin)  : JSON [{option, width, height}, …] — options telles que
//                   stockées par les outils chart_* (jetons « @nom », _elpis…).
// Sortie (stdout) : JSON [{svg} | {error}, …], dans le même ordre.
//
// Jetons, thème et formateurs viennent du bundle `frontend/dist/echarts-ssr.cjs`
// (construit avec le frontend, présent aussi dans la release : web/ = frontend/dist) :
// le graphique d'un document est celui du chat (thème clair, sans animation).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Tache = Record<string, unknown>;
type RenduUn = (tache: Tache) => unknown;

const racine = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundle = process.env["ELPIS_ECHARTS_SSR"] || join(racine, "frontend", "dist", "echarts-ssr.cjs");
if (!existsSync(bundle)) {
  process.stderr.write(
    `echarts_ssr: bundle introuvable (${bundle}) — construire le frontend (npm run build -w @elpis/web)\n`,
  );
  process.exit(3);
}
const { renderOne } = createRequire(import.meta.url)(bundle) as { renderOne: RenduUn };

let entree = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  entree += c;
});
// zrender garde des minuteries : on sort explicitement, mais SEULEMENT une
// fois la sortie vidée — vers un tube, ``write`` est asynchrone et un
// ``exit`` immédiat la couperait (64 Kio), donc tout graphique un peu riche.
function finir(texte: string, code: number): void {
  process.stdout.write(texte, () => process.exit(code));
}

process.stdin.on("end", () => {
  let taches: Tache[];
  try {
    taches = JSON.parse(entree || "[]") as Tache[];
  } catch (e) {
    finir(JSON.stringify({ error: `bad input: ${e instanceof Error ? e.message : String(e)}` }), 2);
    return;
  }
  finir(JSON.stringify(taches.map((t) => renderOne(t))), 0);
});
