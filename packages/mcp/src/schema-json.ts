// SPDX-License-Identifier: MIT
/** packages/mcp/src/schema-json.ts — validation JSON Schema par Ajv (brouillon choisi par `$schema`), erreurs rendues comme python-jsonschema (message, chemin, ordre, meilleure erreur). */
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { Ajv } from "ajv/dist/ajv.js";

import { comparePointsDeCode } from "@elpis/commun";

import { estDict, repr } from "./outils";

/** Erreur au format de `jsonschema` : chemin absolu (clés et indices) et message. */
export interface ErreurSchema {
  chemin: (string | number)[];
  message: string;
}

export type Brouillon = "draft-07" | "2019-09" | "2020-12";

const OPTIONS_AJV = { allErrors: true, verbose: true, strict: false, validateFormats: false } as const;

/** Méta-schémas connus de `validator_for` ; draft-03/04 : `null`, Ajv 8 ne les valide pas. */
const META_SCHEMAS: Readonly<Record<string, Brouillon | null>> = {
  "http://json-schema.org/draft-03/schema": null,
  "http://json-schema.org/draft-04/schema": null,
  "http://json-schema.org/draft-06/schema": "draft-07",
  "http://json-schema.org/draft-07/schema": "draft-07",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
};

/** `validator_for` : `$schema` absent ou inconnu → 2020-12 (le plus récent), sinon le brouillon déclaré. */
function brouillon(schema: unknown): [Brouillon | null, boolean] {
  const brut = estDict(schema) ? schema["$schema"] : undefined;
  if (brut === undefined) return ["2020-12", true];
  const cle = String(brut)
    .replace(/#$/, "")
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, (s) => s.toLowerCase());
  if (!Object.hasOwn(META_SCHEMAS, cle)) return ["2020-12", false];
  const b = META_SCHEMAS[cle] ?? null;
  return [b, cle !== "http://json-schema.org/draft-06/schema"];
}

/** Validateur du brouillon déclaré ou `impose` (une instance Ajv par schéma : pas de collision de `$id`) ; `null` pour draft-03/04 ; un schéma invalide lève. */
export function compilerSchema(schema: unknown, impose: Brouillon | null = null): ValidateFunction | null {
  const [declare, connu] = brouillon(schema);
  const b = impose ?? declare;
  if (b === null) return null;
  let cible = schema;
  if (!(connu && (impose === null || declare === impose)) && estDict(schema)) {
    const copie = { ...schema };
    delete copie["$schema"];
    cible = copie;
  }
  const ajv =
    b === "draft-07"
      ? new Ajv(OPTIONS_AJV)
      : b === "2019-09"
        ? new Ajv2019(OPTIONS_AJV)
        : new Ajv2020(OPTIONS_AJV);
  const valider = ajv.compile(cible as object);
  brouillons.set(valider, b);
  return valider;
}

const brouillons = new WeakMap<ValidateFunction, Brouillon>();

function decoderPointeur(pointeur: string): string[] {
  if (!pointeur) return [];
  return pointeur
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Chemin de l'instance : un segment sous une liste est un indice (Python les distingue des clés). */
function cheminInstance(racine: unknown, pointeur: string): (string | number)[] {
  const out: (string | number)[] = [];
  let noeud = racine;
  for (const seg of decoderPointeur(pointeur)) {
    if (Array.isArray(noeud)) {
      const i = Number(seg);
      out.push(i);
      noeud = noeud[i];
    } else {
      out.push(seg);
      noeud = estDict(noeud) ? noeud[seg] : undefined;
    }
  }
  return out;
}

/** Schéma visé par un `schemaPath` Ajv (`#/$defs/x/properties/y`). */
function resoudre(schema: unknown, schemaPath: string): unknown {
  let noeud = schema;
  for (const seg of decoderPointeur(schemaPath.replace(/^#/, ""))) {
    noeud = Array.isArray(noeud) ? noeud[Number(seg)] : estDict(noeud) ? noeud[seg] : undefined;
  }
  return noeud;
}

/** Sous-schémas atteignables depuis `depart`, `$ref` locaux suivis. */
function atteignables(racine: unknown, depart: unknown): Set<unknown> {
  const vus = new Set<unknown>();
  const pile = [depart];
  while (pile.length > 0) {
    const n = pile.pop();
    if (typeof n !== "object" || n === null || vus.has(n)) continue;
    vus.add(n);
    if (Array.isArray(n)) pile.push(...(n as unknown[]));
    else
      for (const [k, v] of Object.entries(n))
        if (k === "$ref" && typeof v === "string" && v.startsWith("#")) pile.push(resoudre(racine, v));
        else if (!["enum", "const", "default", "examples"].includes(k)) pile.push(v);
  }
  return vus;
}

function sousChemin(pointeur: string, base: string): boolean {
  return pointeur === base || pointeur.startsWith(base + "/");
}

/** Erreurs posées dans les branches d'un `oneOf`/`anyOf` (ou les essais de `contains`) en échec : jsonschema ne les liste pas. */
function erreursDeBranches(
  toutes: ErrorObject[],
  racine: unknown,
): { exclues: Set<ErrorObject>; trouves: Map<ErrorObject, number> } {
  const exclues = new Set<ErrorObject>();
  const trouves = new Map<ErrorObject, number>();
  toutes.forEach((e, j) => {
    if (e.keyword !== "oneOf" && e.keyword !== "anyOf" && e.keyword !== "contains") return;
    const branches = atteignables(racine, e.schema);
    const echecs = new Set<string>();
    for (const x of toutes.slice(0, j))
      if (branches.has(x.parentSchema) && sousChemin(x.instancePath, e.instancePath)) {
        exclues.add(x);
        echecs.add(x.instancePath.slice(e.instancePath.length).split("/")[1] ?? "");
      }
    if (e.keyword === "contains" && Array.isArray(e.data)) trouves.set(e, e.data.length - echecs.size);
  });
  return { exclues, trouves };
}

/** Message du mot-clé `items: false` (2020-12) au-delà de `prefixItems`. */
function itemsEnTrop(liste: unknown[], prefixe: number): string {
  const surplus = liste.length - prefixe;
  const reste: unknown = surplus === 1 ? liste[prefixe] : liste.slice(prefixe);
  return `Expected at most ${prefixe} ${prefixe === 1 ? "item" : "items"} but found ${surplus} extra: ${repr(reste)}`;
}

const DESCENTES_AVEC_CHEMIN = new Set([
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "prefixItems",
  "additionalItems",
]);

/** Schéma `false` atteint : jsonschema n'ajoute pas le segment de la descente (chemin du parent) ; `items` 2020-12 le traite en mot-clé. */
function schemaFaux(
  e: ErrorObject,
  b: Brouillon | undefined,
  instance: unknown,
): { chemin: (string | number)[]; items: boolean } {
  const avant = e.schemaPath.replace(/^#\//, "").split("/").slice(0, -1);
  const dernier = avant[avant.length - 1] ?? "";
  const motCle = ["additionalProperties", "items", "additionalItems"].includes(dernier)
    ? dernier
    : (avant[avant.length - 2] ?? "");
  const chemin = cheminInstance(instance, e.instancePath);
  return {
    chemin: DESCENTES_AVEC_CHEMIN.has(motCle) ? chemin.slice(0, -1) : chemin,
    items: dernier === "items" && b === "2020-12",
  };
}

function seuil(e: ErrorObject): unknown {
  return (e.params as Record<string, unknown>)["limit"];
}

/** Message de python-jsonschema pour l'erreur Ajv ; `null` : pas d'erreur en Python (`if`, résumé de `propertyNames`). */
function message(e: ErrorObject, schema: unknown, trouves: number | undefined): string | null {
  const p = e.params as Record<string, unknown>;
  const valeur = repr(e.propertyName ?? e.data);
  switch (e.keyword) {
    case "type": {
      const types = Array.isArray(p["type"]) ? (p["type"] as unknown[]) : String(p["type"]).split(",");
      return `${valeur} is not of type ${types.map((t) => repr(t)).join(", ")}`;
    }
    case "enum":
      return `${valeur} is not one of ${repr(p["allowedValues"])}`;
    case "const":
      return `${repr(p["allowedValue"])} was expected`;
    case "minimum":
      return `${valeur} is less than the minimum of ${repr(seuil(e))}`;
    case "maximum":
      return `${valeur} is greater than the maximum of ${repr(seuil(e))}`;
    case "exclusiveMinimum":
      return `${valeur} is less than or equal to the minimum of ${repr(seuil(e))}`;
    case "exclusiveMaximum":
      return `${valeur} is greater than or equal to the maximum of ${repr(seuil(e))}`;
    case "multipleOf":
      return `${valeur} is not a multiple of ${repr(p["multipleOf"])}`;
    case "minLength":
    case "minItems":
      return `${valeur} ${seuil(e) === 1 ? "should be non-empty" : "is too short"}`;
    case "maxLength":
    case "maxItems":
      return `${valeur} ${seuil(e) === 0 ? "is expected to be empty" : "is too long"}`;
    case "minProperties":
      return `${valeur} ${seuil(e) === 1 ? "should be non-empty" : "does not have enough properties"}`;
    case "maxProperties":
      return `${valeur} ${seuil(e) === 0 ? "is expected to be empty" : "has too many properties"}`;
    case "uniqueItems":
      return `${valeur} has non-unique elements`;
    case "required":
      return `${repr(p["missingProperty"])} is a required property`;
    case "dependencies":
    case "dependentRequired":
      return `${repr(p["missingProperty"])} is a dependency of ${repr(p["property"])}`;
    case "pattern":
      return `${valeur} does not match ${repr(p["pattern"])}`;
    case "not":
      return `${valeur} should not be valid under ${repr(e.schema)}`;
    case "contains": {
      const min = typeof p["minContains"] === "number" ? p["minContains"] : 1;
      const max = p["maxContains"];
      if (trouves === undefined) return e.message ?? e.keyword;
      if (typeof max === "number" && trouves > max)
        return `Too many items match the given schema (expected at most ${max})`;
      if (trouves === 0) return `${valeur} does not contain items matching the given schema`;
      return `Too few items match the given schema (expected at least ${min} but only ${trouves} matched)`;
    }
    case "items": {
      const prefixe = Number(seuil(e));
      if (!Array.isArray(e.data) || !Number.isInteger(prefixe)) return e.message ?? e.keyword;
      return itemsEnTrop(e.data, prefixe);
    }
    case "additionalItems":
    case "unevaluatedItems": {
      const reste = Array.isArray(e.data) ? e.data.slice(Number(seuil(e))) : [];
      const quoi = e.keyword === "additionalItems" ? "Additional" : "Unevaluated";
      return `${quoi} items are not allowed (${reste.map((x) => repr(x)).join(", ")} ${reste.length === 1 ? "was" : "were"} unexpected)`;
    }
    case "anyOf":
      return `${valeur} is not valid under any of the given schemas`;
    case "oneOf": {
      const passants = p["passingSchemas"];
      if (!Array.isArray(passants)) return `${valeur} is not valid under any of the given schemas`;
      const branches = resoudre(schema, e.schemaPath);
      const valides = [...(passants as number[])].sort((a, b) => a - b);
      const ordre = [...valides.slice(1), valides[0] ?? 0];
      const reprs = ordre.map((i) => repr(Array.isArray(branches) ? branches[i] : null));
      return `${valeur} is valid under each of ${reprs.join(", ")}`;
    }
    case "if":
    case "propertyNames":
      return null;
    default:
      return e.message ?? e.keyword;
  }
}

/** Rang du mot-clé dans son schéma parent : jsonschema les parcourt dans l'ordre du fichier. */
function rangMotCle(schema: unknown, e: ErrorObject): number {
  const segs = e.schemaPath.split("/");
  const iProp = segs.lastIndexOf("propertyNames");
  const fin = iProp >= 0 ? iProp : segs.length - 1;
  const parent = resoudre(schema, segs.slice(0, fin).join("/"));
  return estDict(parent) ? Object.keys(parent).indexOf(segs[fin] ?? "") : 0;
}

function comparerChemins(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return comparePointsDeCode(String(x), String(y));
  }
  return a.length - b.length;
}

/** `is_type(instance, type)` de jsonschema sur une valeur JSON. */
function estDuType(v: unknown, type: unknown): boolean {
  switch (type) {
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return estDict(v);
    default:
      return false;
  }
}

interface Detail extends ErreurSchema {
  rang: number;
  ordre: number;
  faible: boolean;
  typeConcorde: boolean;
}

/** `_matches_type` : le schéma qui échoue déclare un `type` que l'instance porte. */
function typeConcorde(e: ErrorObject, instance: unknown): boolean {
  const parent = e.parentSchema;
  if (!estDict(parent) || !Object.hasOwn(parent, "type")) return false;
  const t = parent["type"];
  return Array.isArray(t) ? t.some((x) => estDuType(instance, x)) : estDuType(instance, t);
}

function valeurA(racine: unknown, chemin: (string | number)[]): unknown {
  let n = racine;
  for (const seg of chemin) n = Array.isArray(n) ? n[Number(seg)] : estDict(n) ? n[String(seg)] : undefined;
  return n;
}

function details(valider: ValidateFunction, schema: unknown, instance: unknown): Detail[] {
  if (valider(instance)) return [];
  const toutes = valider.errors ?? [];
  const { exclues, trouves } = erreursDeBranches(toutes, schema);
  const brutes = toutes.filter((e) => !exclues.has(e));
  const groupes = new Map<string, { e: ErrorObject; cles: string[]; ordre: number }>();
  const itemsFaux = new Map<string, { e: ErrorObject; chemin: (string | number)[]; ordre: number }>();
  const b = brouillons.get(valider);
  const out: Detail[] = [];
  brutes.forEach((e, ordre) => {
    const p = e.params as Record<string, unknown>;
    if (e.keyword === "false schema") {
      const { chemin, items } = schemaFaux(e, b, instance);
      if (items) {
        if (!itemsFaux.has(JSON.stringify(chemin)))
          itemsFaux.set(JSON.stringify(chemin), { e, chemin, ordre });
        return;
      }
      out.push({
        chemin,
        message: `False schema does not allow ${repr(e.data)}`,
        rang: rangMotCle(schema, e),
        ordre,
        faible: false,
        typeConcorde: false,
      });
      return;
    }
    const groupe =
      (e.keyword === "additionalProperties" && e.parentSchema?.["additionalProperties"] === false) ||
      (e.keyword === "unevaluatedProperties" && e.parentSchema?.["unevaluatedProperties"] === false);
    if (groupe) {
      const cle = `${e.keyword}\u0000${e.instancePath}`;
      const nom = String(p["additionalProperty"] ?? p["unevaluatedProperty"]);
      const deja = groupes.get(cle);
      if (deja) deja.cles.push(nom);
      else groupes.set(cle, { e, cles: [nom], ordre });
      return;
    }
    const m = message(e, schema, trouves.get(e));
    if (m === null) return;
    const chemin = cheminInstance(instance, e.instancePath);
    out.push({
      chemin,
      message: m,
      rang: rangMotCle(schema, e),
      ordre,
      faible: e.keyword === "anyOf" || e.keyword === "oneOf",
      typeConcorde: typeConcorde(e, e.propertyName ?? e.data),
    });
  });
  for (const { e, chemin, ordre } of itemsFaux.values()) {
    const liste = valeurA(instance, chemin);
    out.push({
      chemin,
      message: itemsEnTrop(Array.isArray(liste) ? liste : [], 0),
      rang: rangMotCle(schema, e),
      ordre,
      faible: false,
      typeConcorde: false,
    });
  }
  for (const { e, cles, ordre } of groupes.values()) {
    const triees = [...new Set(cles)].sort(comparePointsDeCode);
    const liste = triees.map((c) => repr(c)).join(", ");
    const verbe = triees.length === 1 ? "was" : "were";
    const motifs = e.parentSchema?.["patternProperties"];
    let m: string;
    if (e.keyword === "unevaluatedProperties")
      m = `Unevaluated properties are not allowed (${liste} ${verbe} unexpected)`;
    else if (estDict(motifs))
      m = `${liste} ${triees.length === 1 ? "does" : "do"} not match any of the regexes: ${Object.keys(motifs)
        .sort(comparePointsDeCode)
        .map((x) => repr(x))
        .join(", ")}`;
    else m = `Additional properties are not allowed (${liste} ${verbe} unexpected)`;
    out.push({
      chemin: cheminInstance(instance, e.instancePath),
      message: m,
      rang: rangMotCle(schema, e),
      ordre,
      faible: false,
      typeConcorde: typeConcorde(e, e.data),
    });
  }
  return out;
}

/** `sorted(validator.iter_errors(instance), key=absolute_path)` avec les messages de python-jsonschema ; `null` (brouillon non pris en charge) : aucune. */
export function erreursSchema(
  valider: ValidateFunction | null,
  schema: unknown,
  instance: unknown,
): ErreurSchema[] {
  if (valider === null) return [];
  const out = details(valider, schema, instance);
  out.sort((a, b) => comparerChemins(a.chemin, b.chemin) || a.rang - b.rang || a.ordre - b.ordre);
  return out.map(({ chemin, message: m }) => ({ chemin, message: m }));
}

/** `best_match` : chemin le plus court, puis le plus grand, mot-clé fort, type non concordant ; à égalité le premier rencontré (contexte oneOf/anyOf non descendu). */
export function meilleureErreur(
  valider: ValidateFunction | null,
  schema: unknown,
  instance: unknown,
): ErreurSchema | null {
  if (valider === null) return null;
  const tri = details(valider, schema, instance).sort((a, b) => a.rang - b.rang || a.ordre - b.ordre);
  let meilleure: Detail | null = null;
  for (const d of tri) {
    if (meilleure === null) {
      meilleure = d;
      continue;
    }
    const cmp =
      meilleure.chemin.length - d.chemin.length ||
      comparerChemins(d.chemin, meilleure.chemin) ||
      Number(!d.faible) - Number(!meilleure.faible) ||
      Number(!d.typeConcorde) - Number(!meilleure.typeConcorde);
    if (cmp > 0) meilleure = d;
  }
  return meilleure === null ? null : { chemin: meilleure.chemin, message: meilleure.message };
}
