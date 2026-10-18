// SPDX-License-Identifier: MIT
/** apps/core/src/administration/voix.ts — tests du moteur vocal par la console : formulaire fusionné à la config enregistrée, écarts non enregistrés, avertissements, sondes et listes par le client vocal (shared_infra/routes/admin/integrations.py). */
import {
  estDict,
  estErreurPython,
  getPy,
  intPy,
  lowerPy,
  maxPy,
  minPy,
  ouPy,
  rstripPy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import type { Journal } from "../journal";
import { configVoix, drapeauxVoix } from "../voix/config";
import type { ConfigVoix } from "../voix/config";
import { VoiceError } from "../voix/erreurs";
import { clientVoix } from "../voix/ports";

const CHAMPS_VOIX = ["endpoint_url", "format", "model", "language", "prompt", "token", "voice"] as const;
type Section = "stt" | "tts";

function messageDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `_fusion_voix` : config enregistrée + surcharges du formulaire (bornes gardées), délai d'un test plafonné à 30 s. */
export function fusionVoix(enregistree: ConfigVoix, data: Dict, section: Section): Dict {
  const base: Dict = { ...enregistree[section] };
  const brut = getPy(data, section);
  if (estDict(brut)) {
    for (const cle of CHAMPS_VOIX) {
      const v = getPy(brut, cle);
      if (v !== null) base[cle] = stripPy(strPy(v));
    }
    const verify = getPy(brut, "verify");
    if (verify !== null)
      base["verify"] = verify !== false && !["false", "0"].includes(lowerPy(stripPy(strPy(verify))));
    base["endpoint_url"] = rstripPy(texteOu(getPy(base, "endpoint_url"), ""), "/");
    base["format"] = lowerPy(texteOu(getPy(base, "format"), ""));
    try {
      const delai = getPy(brut, "timeout_sec");
      if (delai !== null) base["timeout_sec"] = maxPy(2, minPy(60, intPy(delai)));
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    }
  }
  base["timeout_sec"] = minPy(intPy(ouPy(getPy(base, "timeout_sec"), 30)), 30);
  return base;
}

/** `_ecarts_voix` : champs ENVOYÉS qui diffèrent de la config enregistrée (vide contre défaut n'en est pas un). */
export function ecartsVoix(enregistree: ConfigVoix, data: Dict): string[] {
  const defauts = configVoix({});
  const ecarts: string[] = [];
  if (Object.hasOwn(data, "enabled") && (getPy(data, "enabled") === true) !== enregistree.enabled)
    ecarts.push("enabled");
  for (const section of ["stt", "tts"] as const) {
    const brut = getPy(data, section);
    if (!estDict(brut)) continue;
    const fusion = fusionVoix(enregistree, data, section);
    const actuelle: Dict = enregistree[section];
    for (const cle of [...CHAMPS_VOIX, "verify"]) {
      if (getPy(brut, cle) === null || !Object.hasOwn(actuelle, cle)) continue;
      const valeur = getPy(fusion, cle);
      if (valeur === "" && actuelle[cle] === (defauts[section] as Dict)[cle]) continue;
      if (valeur !== actuelle[cle]) ecarts.push(`${section}.${cle}`);
    }
  }
  return ecarts;
}

/** Ce qui manque encore pour que la voix marche, au-delà d'un test vert. */
function avertissements(
  enregistree: ConfigVoix,
  ecarts: readonly string[],
  drapeaux: [boolean, boolean],
  https: boolean,
): string[] {
  const actifs = drapeaux[0] || drapeaux[1];
  const sortie: string[] = [];
  if (!enregistree.enabled) sortie.push("Moteur vocal désactivé (case Activer).");
  if (ecarts.length > 0) sortie.push("Configuration non enregistrée : le test porte sur le formulaire.");
  if (enregistree.enabled && !actifs)
    sortie.push("Aucune adresse enregistrée : ni dictée ni lecture ne sont actives.");
  if (actifs) sortie.push("Chaque utilisateur doit cocher Dictée / Réponse vocale dans ses Paramètres.");
  if (ecarts.length > 0 || !actifs || !enregistree.enabled)
    sortie.push("Après enregistrement, rechargez la page pour voir le micro.");
  if (!https) sortie.push("Le micro exige HTTPS (ou localhost) : activez HTTPS dans Sécurité › Accès HTTPS.");
  return sortie;
}

/** `_sonde` : adresse et modèle exigés, puis la sonde ; un échec vocal ou inattendu devient `{ok: false}`. */
async function sonder(
  enregistree: ConfigVoix,
  data: Dict,
  section: Section,
  journal: Journal,
): Promise<Dict> {
  const cfg = fusionVoix(enregistree, data, section);
  if (!veritePy(cfg["endpoint_url"])) return { ok: false, error: "Aucune adresse renseignée." };
  if (section === "tts" && cfg["format"] === "openai" && !veritePy(getPy(cfg, "model")))
    return { ok: false, error: "Format openai : renseignez le modèle de synthèse (ex. tts-1)." };
  try {
    const client = clientVoix();
    return { ok: true, ...(await (section === "stt" ? client.sondeStt(cfg) : client.sondeTts(cfg))) };
  } catch (e) {
    if (e instanceof VoiceError) return { ok: false, error: e.message, detail: e.detail || null };
    journal.error({ err: e }, `[admin/voice/test] ${section} : erreur inattendue`);
    return { ok: false, error: `Erreur interne : ${messageDe(e)}` };
  }
}

/** `POST /api/admin/voice/test` : les deux services sondés en parallèle, état enregistré et avertissements. */
export async function testerVoix(data: Dict, https: boolean, journal: Journal): Promise<Dict> {
  const enregistree = configVoix();
  const [stt, tts] = await Promise.all([
    sonder(enregistree, data, "stt", journal),
    sonder(enregistree, data, "tts", journal),
  ]);
  const drapeaux = drapeauxVoix(enregistree);
  const ecarts = ecartsVoix(enregistree, data);
  return {
    ok: veritePy(stt["ok"]) && veritePy(tts["ok"]),
    stt,
    tts,
    enabled: enregistree.enabled,
    saved_matches_form: ecarts.length === 0,
    unsaved: ecarts,
    flags: { stt: drapeaux[0], tts: drapeaux[1] },
    https,
    warnings: avertissements(enregistree, ecarts, drapeaux, https),
  };
}

/** `POST /api/admin/voice/models` : modèles ou voix chargés par le serveur, valeurs du formulaire (sinon enregistrées). */
export async function modelesVoix(data: Dict, journal: Journal): Promise<Dict> {
  const echec = (error: string): Dict => ({ ok: false, models: [], current: null, source: "", error });
  const section = lowerPy(stripPy(strPy(ouPy(getPy(data, "section"), ""))));
  if (section !== "stt" && section !== "tts") return echec("Section inconnue : « stt » ou « tts ».");
  const cfg = fusionVoix(configVoix(), { [section]: data }, section);
  if (!veritePy(cfg["endpoint_url"])) return echec("Aucune adresse renseignée.");
  let resultat: Dict;
  try {
    resultat = await clientVoix().listeModeles(section, cfg);
  } catch (e) {
    if (e instanceof VoiceError) {
      const sortie = echec(e.message);
      if (e.detail) sortie["detail"] = e.detail;
      return sortie;
    }
    journal.error({ err: e }, `[admin/voice/models] ${section} : erreur inattendue`);
    return echec(`Erreur interne : ${messageDe(e)}`);
  }
  return { ok: true, ...resultat };
}
