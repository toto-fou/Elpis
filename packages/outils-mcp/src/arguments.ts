// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/arguments.ts — arguments d'un outil validés comme `TypeAdapter(fonction).validate_python` (pydantic lax) et texte de la ValidationError. */
import { clesOrdonnees, estDict, FlottantPy, nomTypePy, objetNu, reprPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { SchemaPy, validerPy } from "@elpis/http";
import type { Champs, ErreurPy } from "@elpis/http";

/** Version de pydantic dans l'URL des erreurs (`errors.pydantic.dev/<x.y>`). */
export const VERSION_PYDANTIC = "2.13";

/** Signature Python d'un outil : nom de la fonction (`call[<fonction>]`) et paramètres dans l'ordre déclaré. */
export interface Signature {
  readonly fonction: string;
  readonly parametres: Champs;
  /** Paramètres déclarés après `*` : l'absence d'un requis est « missing_keyword_only_argument ». */
  readonly motsClesSeuls?: boolean;
}

export type ResultatArguments =
  { ok: true; valeurs: Dict } | { ok: false; erreurs: ErreurPy[]; titre: string; texte: string };

/** `model_validator(mode="before")` / `field_validator(mode="before")` : l'entrée passe par `f` avant `schema`. */
export function avant<T>(schema: SchemaPy<T>, f: (entree: unknown) => unknown): SchemaPy<T> {
  return new SchemaPy<T>((entree, loc, etat) => schema.verifier(f(entree), loc, etat), schema.options);
}

/** Valeurs JSON ordinaires pour les validateurs : `FlottantPy` → nombre, entier long → nombre. */
function ordinaire(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(ordinaire);
  if (estDict(v)) {
    const copie: Dict = objetNu();
    for (const k of clesOrdonnees(v)) copie[k] = ordinaire(v[k]);
    return copie;
  }
  return v;
}

function valeurA(racine: unknown, chemin: readonly (string | number)[]): unknown {
  let n = racine;
  for (const seg of chemin) n = Array.isArray(n) ? n[Number(seg)] : estDict(n) ? n[String(seg)] : undefined;
  return n;
}

/** Entrée d'une erreur rendue sous sa forme reçue (flottant `1.0`, entier long) : la plus longue racine de `loc` qui la porte. */
function entreeOrigine(e: ErreurPy, origine: unknown, copie: unknown): unknown {
  for (let n = e.loc.length; n >= 0; n--) {
    const chemin = e.loc.slice(0, n);
    const v = valeurA(copie, chemin);
    if (v === e.input && (v !== undefined || n === 0)) return valeurA(origine, chemin);
  }
  return e.input;
}

/** Valide `args` (kwargs) : paramètres dans l'ordre, puis arguments inattendus dans l'ordre reçu. */
export function validerArguments(signature: Signature, args: Dict): ResultatArguments {
  const copie = ordinaire(args) as Dict;
  const erreurs: ErreurPy[] = [];
  const valeurs: Dict = {};
  const acceptees = new Set<string>();
  for (const [nom, schema] of Object.entries(signature.parametres)) {
    const cle = schema.options.alias ?? nom;
    acceptees.add(cle);
    if (Object.hasOwn(copie, cle)) {
      const r = validerPy(schema, copie[cle], [cle]);
      if (r.ok) valeurs[nom] = r.valeur;
      else erreurs.push(...r.erreurs);
    } else if (schema.options.defaut) valeurs[nom] = schema.options.defaut();
    else if (signature.motsClesSeuls)
      erreurs.push({
        type: "missing_keyword_only_argument",
        loc: [cle],
        msg: "Missing required keyword only argument",
        input: copie,
      });
    else
      erreurs.push({ type: "missing_argument", loc: [cle], msg: "Missing required argument", input: copie });
  }
  for (const k of clesOrdonnees(copie))
    if (!acceptees.has(k))
      erreurs.push({
        type: "unexpected_keyword_argument",
        loc: [k],
        msg: "Unexpected keyword argument",
        input: copie[k],
      });
  if (erreurs.length === 0) return { ok: true, valeurs };
  const rendues = erreurs.map((e) => ({ ...e, input: entreeOrigine(e, args, copie) }));
  const titre = `call[${signature.fonction}]`;
  return { ok: false, erreurs: rendues, titre, texte: texteValidationError(titre, rendues) };
}

/** `repr` d'au plus 50 octets UTF-8, sinon 25 octets de tête et 24 de queue aux frontières de caractères. */
export function tronquerEntree(repr: string): string {
  const o = Buffer.from(repr, "utf8");
  if (o.length <= 50) return repr;
  let tete = 25;
  while (tete > 0 && ((o[tete] ?? 0) & 0xc0) === 0x80) tete--;
  let queue = o.length - 24;
  while (queue < o.length && ((o[queue] ?? 0) & 0xc0) === 0x80) queue++;
  return `${o.subarray(0, tete).toString("utf8")}...${o.subarray(queue).toString("utf8")}`;
}

/** `str(ValidationError)` de pydantic-core. */
export function texteValidationError(titre: string, erreurs: readonly ErreurPy[]): string {
  const n = erreurs.length;
  const lignes = [`${n} validation error${n === 1 ? "" : "s"} for ${titre}`];
  for (const e of erreurs) {
    lignes.push(e.loc.map((x) => String(x)).join("."));
    lignes.push(
      `  ${e.msg} [type=${e.type}, input_value=${tronquerEntree(reprPy(e.input))}, input_type=${nomTypePy(e.input)}]`,
    );
    lignes.push(
      `    For further information visit https://errors.pydantic.dev/${VERSION_PYDANTIC}/v/${e.type}`,
    );
  }
  return lignes.join("\n");
}
