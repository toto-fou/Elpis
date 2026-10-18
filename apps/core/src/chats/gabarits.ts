// SPDX-License-Identifier: MIT
/** apps/core/src/chats/gabarits.ts — templates de prompt d'un compte (shared_infra/chat/prompt_templates_store.py), appelés par « /template <nom> ». */
import {
  estDict,
  getOu,
  longueurPy,
  lowerPy,
  prefixePy,
  splitPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import { ErreurIntegrite } from "@elpis/db";
import type { Base, Executeur, Ligne } from "@elpis/db";

import { flottants } from "./prompts";
import { maintenant } from "./stockage";

const NOM = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const TITRE_MAX = 120;
export const CONTENU_MAX = 20_000;
export const MAX_PAR_COMPTE = 200;
const COLONNES = "id, name, title, content, created_at, updated_at";

/** `TemplateError` : entrée refusée, `status` = code HTTP à renvoyer. */
export class ErreurGabarit extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TemplateError";
    this.status = status;
  }
}

export interface Gabarit {
  name: string;
  title: string;
  content: string;
}

/** `str(d.get(cle) or "")`. */
function champ(d: Record<string, unknown>, cle: string): string {
  const v = getOu(d, cle, null);
  return strPy(veritePy(v) ? v : "");
}

/** `normalize` : champs reçus du client → valeurs validées, ErreurGabarit (400) sinon. */
export function normaliser(data: unknown): Gabarit {
  const d = estDict(data) ? data : {};
  let name = lowerPy(stripPy(champ(d, "name")));
  if (name.startsWith("/")) name = name.slice(1);
  if (!NOM.test(name))
    throw new ErreurGabarit(
      "Raccourci invalide : lettres minuscules, chiffres, - et _ (40 caractères au plus), sans espace.",
    );
  const content = champ(d, "content");
  if (!stripPy(content)) throw new ErreurGabarit("Contenu requis.");
  if (longueurPy(content) > CONTENU_MAX)
    throw new ErreurGabarit(`Contenu trop long (${CONTENU_MAX} caractères au plus).`);
  const title = prefixePy(splitPy(champ(d, "title")).join(" "), TITRE_MAX) || name;
  return { name, title, content };
}

export async function listTemplates(x: Executeur, uid: number): Promise<Ligne[]> {
  return (await x.all(`SELECT ${COLONNES} FROM prompt_templates WHERE user_id=? ORDER BY name`, [uid])).map(
    (l) => flottants(l, "created_at", "updated_at"),
  );
}

function doublon(name: string): ErreurGabarit {
  return new ErreurGabarit(`Un template s'appelle déjà « ${name} ».`, 409);
}

/** `create_template` : 409 au-delà de la limite du compte ou si le raccourci existe déjà. */
export async function createTemplate(
  base: Base,
  uid: number,
  data: unknown,
): Promise<Record<string, unknown>> {
  const t = normaliser(data);
  const quand = maintenant();
  return base.transaction(async (tx) => {
    const [[n] = [0]] = await tx.valeurs<[number]>("SELECT COUNT(*) FROM prompt_templates WHERE user_id=?", [
      uid,
    ]);
    if (Number(n) >= MAX_PAR_COMPTE)
      throw new ErreurGabarit(`Limite de ${MAX_PAR_COMPTE} templates atteinte.`, 409);
    let id: number;
    try {
      id = await tx.insertId(
        "INSERT INTO prompt_templates(user_id, name, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?)",
        [uid, t.name, t.title, t.content, quand, quand],
      );
    } catch (e) {
      if (e instanceof ErreurIntegrite) throw doublon(t.name);
      throw e;
    }
    return { id, ...t, created_at: versFlottantPy(quand), updated_at: versFlottantPy(quand) };
  });
}

/** `update_template` : `null` si le template n'est pas à ce compte ; 409 si le raccourci est pris. */
export async function updateTemplate(
  base: Base,
  uid: number,
  templateId: number,
  data: unknown,
): Promise<Ligne | null> {
  const t = normaliser(data);
  const quand = maintenant();
  let n: number;
  try {
    n = (
      await base.run(
        "UPDATE prompt_templates SET name=?, title=?, content=?, updated_at=? WHERE id=? AND user_id=?",
        [t.name, t.title, t.content, quand, templateId, uid],
      )
    ).changes;
  } catch (e) {
    if (e instanceof ErreurIntegrite) throw doublon(t.name);
    throw e;
  }
  if (n === 0) return null;
  const l = await base.get(`SELECT ${COLONNES} FROM prompt_templates WHERE id=? AND user_id=?`, [
    templateId,
    uid,
  ]);
  return l ? flottants(l, "created_at", "updated_at") : null;
}

export async function deleteTemplate(x: Executeur, uid: number, templateId: number): Promise<boolean> {
  return (
    (await x.run("DELETE FROM prompt_templates WHERE id=? AND user_id=?", [templateId, uid])).changes > 0
  );
}
