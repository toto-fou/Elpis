#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/** migration-kit/goldens_check.mts — contrôle des goldens du flux NDJSON (`tests/goldens/*.json`) contre le registre généré. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRE = join(RACINE, "packages", "contracts", "src", "stream-events.gen.ts");

type Dict = Record<string, unknown>;
interface Famille {
  libelle: string;
  cles: string[];
  sinon: string | null;
}
interface Arguments {
  json: boolean;
  exigerEntrees: boolean;
  dossier: string;
  rejeux: string | null;
}
interface EvenementLu {
  type: string;
  cle: string;
  index: number;
}
interface Registre {
  STREAM_EVENT_TYPES: readonly string[];
  isStreamEventType: (t: string) => boolean;
}
interface Rapport {
  startTime?: number;
  testResults?: { name?: string; assertionResults?: { status?: string; fullName: string }[] }[];
}

const estDict = (x: unknown): x is Dict => x !== null && typeof x === "object" && !Array.isArray(x);

// [préfixe, libellé, clés d'événements dont une est exigée, sortie admise à leur place]
const FAMILLES: [string, string, string[], string | null][] = [
  ["boucle_", "scénario de boucle", ["evenements", "evenements_avant_depart"], null],
  ["flux_route_", "scénario de route", ["evenements", "evenements_avant_depart"], null],
  ["payload_", "payload envoyé au moteur", [], null],
  ["events_", "rejeu (séquence de types)", [], null],
  ["ordonnanceur_", "scénario d'ordonnanceur", [], null],
  ["runs_", "scénario d'exécutions (runs)", [], null],
  ["rattachement_", "scénario de rattachement", ["flux"], "refus"],
];
const CLES_EVENEMENTS = ["evenements", "evenements_avant_depart"];
const MOTEURS_CLASSIQUES = ["classique", "panne"];
const CLES_COMPTEES = ["evenements", "flux"];
/** Tests de forme (registre, émetteurs) : ils lisent tous les goldens sans les rejouer. */
const FICHIERS_DE_FORME = /[\\/]packages[\\/]contracts[\\/]test[\\/]/u;
const CLE_ENTREES = "entrees";
const CLE_SORTIE = "sortie";

function lireArguments(argv: string[]): Arguments {
  const args: Arguments = {
    json: false,
    exigerEntrees: false,
    dossier: join(RACINE, "tests", "goldens"),
    rejeux: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") args.json = true;
    else if (a === "--exiger-entrees") args.exigerEntrees = true;
    else if (a === "--dossier" && i + 1 < argv.length) args.dossier = resolve(argv[++i] ?? "");
    else if (a === "--rejeux" && i + 1 < argv.length) args.rejeux = resolve(argv[++i] ?? "");
    else throw new Error(`argument inconnu : ${a}`);
  }
  return args;
}

function famille(nom: string): Famille {
  for (const [prefixe, libelle, cles, sinon] of FAMILLES) {
    if (nom.startsWith(prefixe)) return { libelle, cles, sinon };
  }
  return { libelle: "inconnue", cles: [], sinon: null };
}

/** Chemin de chat classique (sans outils), non porté en TS (décision du user, E23) : golden non rejoué. */
function cheminClassique(nom: string, contenu: unknown): boolean {
  const e = estDict(contenu) ? contenu[CLE_ENTREES] : null;
  if (!estDict(e)) return false;
  if (["boucle_", "payload_", "events_"].some((p) => nom.startsWith(p))) return e["chemin"] === "classique";
  if (nom.startsWith("flux_route_")) {
    const moteur = e["moteur"];
    return (
      estDict(moteur) && typeof moteur["type"] === "string" && MOTEURS_CLASSIQUES.includes(moteur["type"])
    );
  }
  return false;
}

/** Rapport JSON de vitest → titres des tests passés et échoués (contrôles de forme exclus) et raisons de le croire périmé. */
function titresDuRapport(chemin: string, dossier: string) {
  const rapport = JSON.parse(readFileSync(chemin, "utf8")) as Rapport;
  const passes: string[] = [];
  const echecs: string[] = [];
  const perime: string[] = [];
  const debut = rapport.startTime;
  if (debut === undefined || !Number.isFinite(debut)) perime.push("rapport sans startTime");
  else {
    for (const f of readdirSync(dossier).filter((n) => n.endsWith(".json")))
      if (statSync(join(dossier, f)).mtimeMs > debut) perime.push(`${f} modifié après le passage de vitest`);
    for (const f of rapport.testResults ?? []) {
      if (f.name === undefined || !existsSync(f.name)) perime.push(`${f.name} absent`);
      else if (statSync(f.name).mtimeMs > debut) perime.push(`${f.name} modifié après le passage de vitest`);
    }
  }
  for (const f of rapport.testResults ?? []) {
    if (FICHIERS_DE_FORME.test(f.name ?? "")) continue;
    for (const a of f.assertionResults ?? []) {
      if (a.status === "passed") passes.push(a.fullName);
      else if (a.status === "failed") echecs.push(a.fullName);
    }
  }
  return { passes, echecs, perime };
}

/** Le titre cite-t-il ce golden (nom entier, pas un préfixe d'un autre golden) ? */
function cite(titre: string, nom: string): boolean {
  return new RegExp(`(?<![\\w])${nom}(?![\\w])`, "u").test(titre);
}

function refusValide(r: unknown): boolean {
  return estDict(r) && Number.isInteger(r["statut"]) && typeof r["detail"] === "string";
}

function evenementsDe(nom: string, brut: unknown, fam: Famille, erreurs: string[]): EvenementLu[] {
  const out: EvenementLu[] = [];
  let contenu = brut;
  if (estDict(contenu) && Array.isArray(contenu[CLE_SORTIE])) {
    contenu = contenu[CLE_SORTIE];
  }
  if (Array.isArray(contenu)) {
    contenu.forEach((x, i) => {
      if (typeof x === "string") out.push({ type: x, cle: "(liste)", index: i });
    });
    return out;
  }
  if (!estDict(contenu)) {
    erreurs.push(`${nom} : ni objet ni liste`);
    return out;
  }
  const avecEvenements = fam.cles.some((c) => c in contenu);
  if (fam.sinon !== null && avecEvenements === fam.sinon in contenu) {
    erreurs.push(`${nom} : « ${fam.cles.join(" » ou « ")} » ou bien « ${fam.sinon} », exactement un`);
  } else if (fam.sinon !== null && !avecEvenements && !refusValide(contenu[fam.sinon])) {
    erreurs.push(`${nom} › ${fam.sinon} : objet {statut entier, detail texte} attendu`);
  } else if (fam.cles.length > 0 && fam.sinon === null && !avecEvenements) {
    erreurs.push(`${nom} : aucune clé d'événements (${fam.cles.join(", ")})`);
  }
  for (const cle of new Set([...CLES_EVENEMENTS, ...fam.cles])) {
    if (!(cle in contenu)) continue;
    const liste = contenu[cle];
    if (!Array.isArray(liste)) {
      erreurs.push(`${nom} › ${cle} : liste attendue`);
      continue;
    }
    liste.forEach((ev, i) => {
      if (!estDict(ev) || typeof ev["type"] !== "string") {
        erreurs.push(`${nom} › ${cle}[${i}] : événement sans champ « type »`);
        return;
      }
      out.push({ type: ev["type"], cle, index: i });
    });
  }
  return out;
}

export async function controler(dossier: string, rapport: string | null = null) {
  const { STREAM_EVENT_TYPES, isStreamEventType } = (await import(REGISTRE)) as Registre;
  const fichiers = readdirSync(dossier)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const erreurs: string[] = [];
  const horsRegistre: string[] = [];
  const parFamille: Record<string, number> = {};
  const sansEntrees: string[] = [];
  const classiques: string[] = [];
  const typesVus = new Set<string>();
  const titres = rapport === null ? null : titresDuRapport(rapport, dossier);
  const rejeux = {
    rapport,
    rejoues: 0,
    non_rejoues: [] as string[],
    e23_rejoues: [] as string[],
    echecs: [] as string[],
    perime: titres?.perime ?? [],
  };
  let evenementsComptes = 0;
  let evenementsAutres = 0;

  for (const f of fichiers) {
    const nom = basename(f, ".json");
    let contenu: unknown;
    try {
      contenu = JSON.parse(readFileSync(join(dossier, f), "utf8"));
    } catch (e) {
      erreurs.push(`${nom} : JSON illisible (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const fam = famille(nom);
    parFamille[fam.libelle] = (parFamille[fam.libelle] ?? 0) + 1;
    const avecEntrees = estDict(contenu) && CLE_ENTREES in contenu;
    if (!avecEntrees) sansEntrees.push(nom);
    const rejoue = !cheminClassique(nom, contenu);
    if (!rejoue) classiques.push(nom);
    if (titres !== null) {
      const vu = titres.passes.some((t) => cite(t, nom));
      if (titres.echecs.some((t) => cite(t, nom))) rejeux.echecs.push(nom);
      if (vu) rejeux.rejoues++;
      if (vu && !rejoue) rejeux.e23_rejoues.push(nom);
      else if (!vu && rejoue) rejeux.non_rejoues.push(nom);
    }
    for (const ev of evenementsDe(nom, contenu, fam, erreurs)) {
      if (!isStreamEventType(ev.type)) {
        horsRegistre.push(`${nom} › ${ev.cle}[${ev.index}] : « ${ev.type} »`);
      }
      if (!rejoue) continue;
      if (CLES_COMPTEES.includes(ev.cle)) evenementsComptes++;
      else evenementsAutres++;
      if (isStreamEventType(ev.type)) typesVus.add(ev.type);
    }
  }
  return {
    goldens: fichiers.length,
    par_famille: parFamille,
    evenements: evenementsComptes,
    evenements_autres: evenementsAutres,
    hors_registre: horsRegistre,
    types_couverts: STREAM_EVENT_TYPES.filter((t) => typesVus.has(t)),
    types_jamais_figes: STREAM_EVENT_TYPES.filter((t) => !typesVus.has(t)),
    sans_entrees: sansEntrees,
    chemin_classique_e23: classiques,
    rejeux: titres === null ? null : rejeux,
    erreurs,
  };
}

async function main(): Promise<void> {
  const args = lireArguments(process.argv.slice(2));
  const r = await controler(args.dossier, args.rejeux);
  const echec =
    r.erreurs.length > 0 ||
    r.hors_registre.length > 0 ||
    (args.exigerEntrees && r.sans_entrees.length > 0) ||
    (r.rejeux !== null &&
      (r.rejeux.non_rejoues.length > 0 || r.rejeux.echecs.length > 0 || r.rejeux.perime.length > 0));
  if (args.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    const familles = Object.entries(r.par_famille)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    console.log(`${r.goldens} goldens (${familles})`);
    console.log(
      `${r.chemin_classique_e23.length} du chemin classique (non porté, écart E23) : ` +
        "hors des comptes d'événements et de types figés",
    );
    if (r.rejeux !== null) {
      console.log(`${r.rejeux.rejoues}/${r.goldens} rejoués par un test TS passé (${r.rejeux.rapport})`);
      if (r.rejeux.e23_rejoues.length)
        console.log(`  dont E23 rejoués quand même : ${r.rejeux.e23_rejoues.join(", ")}`);
      for (const n of r.rejeux.non_rejoues) console.log(`  ✗ ${n} : aucun test de rejeu passé ne le cite`);
      for (const n of r.rejeux.echecs) console.log(`  ✗ ${n} : un test de rejeu échoue`);
      for (const p of r.rejeux.perime) console.log(`  ✗ rapport périmé : ${p}`);
    }
    console.log(
      `${r.evenements} événements (clés « ${CLES_COMPTEES.join(" », « ")} ») + ` +
        `${r.evenements_autres} contrôlés ailleurs (départ détaché, rejeux)`,
    );
    console.log(`${r.hors_registre.length} type(s) hors registre`);
    for (const h of r.hors_registre) console.log(`  ✗ ${h}`);
    console.log(
      `${r.types_couverts.length}/${r.types_couverts.length + r.types_jamais_figes.length} types du registre figés par au moins un golden`,
    );
    console.log(`${r.sans_entrees.length}/${r.goldens} goldens sans entrées (clé « ${CLE_ENTREES} »)`);
    for (const e of r.erreurs) console.log(`  ✗ ${e}`);
  }
  process.exitCode = echec ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`goldens_check : ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  });
}
