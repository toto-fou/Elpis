// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/skins-perso.ts — habillages personnels côté client : analyse du bloc elpis-skin, vérification et import par l'API, message de correction, état de la modale d'aperçu et événements vers la racine. */
import {
  schemaReponseEnregistrementPerso,
  schemaReponseListePerso,
  schemaRapportPerso,
} from "@elpis/contracts";
import type { CorpsPerso, RapportPerso } from "@elpis/contracts";
import { analyse } from "@elpis/commun/couleurs";
import { PREFIXE_PERSO } from "@elpis/contracts";
import { shallowRef } from "vue";

import { corpsJson, estObjet, lireSchema } from "../../utils/lecture-json";

export type FetchSkins = (url: string, init?: RequestInit) => Promise<Response | null>;

/** Les habillages du compte ont changé : la racine recharge la liste ; `appliquer` porte l'id `perso:<id>` à activer. */
export const EVT_SKINS_PERSO = "elpis:skins-perso";
/** Demande de correction : la racine ajoute `texte` au brouillon du composeur, sans l'envoyer. */
export const EVT_SKIN_CORRECTION = "elpis:skin-correction";

let lire: FetchSkins = (url, init) => fetch(url, { credentials: "same-origin", ...init });

/** Branche le client HTTP authentifié (appelé avec celui du rendu du chat). */
export function configurerSkinsPerso(f: FetchSkins): void {
  lire = f;
}

export type AnalyseBloc = { ok: true; corps: CorpsPerso } | { ok: false; erreur: string };

/** JSON du bloc ```elpis-skin : seul l'objet est exigé ici, le serveur juge le reste. */
export function analyserBlocSkin(texte: string): AnalyseBloc {
  let v: unknown;
  try {
    v = JSON.parse(texte);
  } catch (e) {
    return { ok: false, erreur: "JSON invalide : " + (e instanceof Error ? e.message : String(e)) };
  }
  if (!estObjet(v)) return { ok: false, erreur: "Objet JSON attendu." };
  return { ok: true, corps: v as unknown as CorpsPerso };
}

/** Nom affiché d'un corps de skin (jamais d'HTML : textContent seulement). */
export function nomSkin(corps: CorpsPerso): string {
  const label = typeof corps.label === "string" ? corps.label.trim() : "";
  return label || (typeof corps.id === "string" ? corps.id : "") || "Habillage";
}

/** Trois pastilles [rail, fond, accent] en couleurs numériques seulement, sinon vide. */
export function pastillesSkin(corps: CorpsPerso): string[] {
  const clair = corps.tokens?.light ?? {};
  const brutes =
    Array.isArray(corps.swatch) && corps.swatch.length === 3
      ? corps.swatch
      : [clair["--rail-bg"], clair["--app-bg"], clair["--accent"]];
  const sures = brutes.map((c) => (typeof c === "string" && analyse(c) ? c.trim() : ""));
  return sures.every(Boolean) ? sures : [];
}

export type ResultatVerification = { ok: true; rapport: RapportPerso } | { ok: false; message: string };

const ENTETES_JSON = { "Content-Type": "application/json" };
const CLES_ENVOYEES = ["id", "label", "desc", "description", "darkBase", "tokens", "swatch", "sw"] as const;

/** Corps envoyé au serveur : les seules clés d'un habillage, jamais un `overwrite` venu du modèle. */
function corpsEnvoye(corps: CorpsPerso): Record<string, unknown> {
  const src = corps as unknown as Record<string, unknown>;
  return Object.fromEntries(CLES_ENVOYEES.filter((k) => k in src).map((k) => [k, src[k]]));
}

/** Interroge `/api/skins/perso/verifier` : le rapport est toujours rendu avec 200, un échec réseau est un message. */
export async function verifierSkin(corps: CorpsPerso): Promise<ResultatVerification> {
  const r = await lire("/api/skins/perso/verifier", {
    method: "POST",
    headers: ENTETES_JSON,
    body: JSON.stringify(corpsEnvoye(corps)),
  }).catch(() => null);
  if (!r) return { ok: false, message: "Vérification impossible (réseau ou session)." };
  if (r.status === 403) return { ok: false, message: "Les habillages personnels sont désactivés." };
  const rapport = await lireSchema(r, schemaRapportPerso);
  return rapport
    ? { ok: true, rapport }
    : { ok: false, message: "Vérification impossible (réponse inattendue)." };
}

export type ResultatImport =
  | { type: "ok"; id: string; remplace: boolean; demande: boolean; applique: boolean }
  | { type: "existe" }
  | { type: "refus"; message: string }
  | { type: "echec"; message: string };

/** Enregistre l'habillage pour le compte ; prévient la racine (`EVT_SKINS_PERSO`) et, avec `appliquer`, active le skin. */
export async function importerSkin(
  corps: CorpsPerso,
  options: { overwrite?: boolean; appliquer?: boolean } = {},
): Promise<ResultatImport> {
  const r = await lire("/api/skins/perso", {
    method: "POST",
    headers: ENTETES_JSON,
    body: JSON.stringify({ ...corpsEnvoye(corps), ...(options.overwrite ? { overwrite: true } : {}) }),
  }).catch(() => null);
  if (!r) return { type: "echec", message: "Import impossible (réseau ou session)." };
  if (r.ok) {
    const ok = await lireSchema(r, schemaReponseEnregistrementPerso);
    if (!ok) return { type: "echec", message: "Réponse inattendue du serveur." };
    const id = ok.skin.id;
    const detail: { appliquer?: string; promesse?: Promise<boolean> } = options.appliquer
      ? { appliquer: PREFIXE_PERSO + id }
      : {};
    window.dispatchEvent(new CustomEvent(EVT_SKINS_PERSO, { detail }));
    const applique = options.appliquer ? await (detail.promesse ?? false) : false;
    return { type: "ok", id, remplace: ok.remplace, demande: options.appliquer === true, applique };
  }
  const dto = await corpsJson(r);
  const detail = estObjet(dto) ? dto["detail"] : null;
  if (r.status === 409 && typeof detail === "string")
    return /existe d[ée]j[aà]/i.test(detail) ? { type: "existe" } : { type: "refus", message: detail };
  if (r.status === 403) return { type: "refus", message: "Les habillages personnels sont désactivés." };
  const rapport = schemaRapportPerso.safeParse(detail);
  if (rapport.success) return { type: "refus", message: rapport.data.erreurs.join(" ") };
  return { type: "echec", message: typeof detail === "string" ? detail : "Import refusé." };
}

/** Phrase de retour d'un import, commune à la carte du chat et à la modale d'aperçu. */
export function libelleImport(r: ResultatImport): string {
  if (r.type === "ok") {
    const base = r.remplace ? "Habillage remplacé" : "Habillage importé";
    if (r.applique) return base + " et appliqué.";
    return r.demande ? base + ", mais non appliqué." : base + ".";
  }
  if (r.type === "existe") return "Un habillage portant cet identifiant existe déjà.";
  return r.message;
}

/** Habillages du compte et plafond ; `null` quand la fonction est coupée (403) ou la lecture échoue. */
export async function listerSkinsPerso(): Promise<{ nombre: number; max: number } | null> {
  const d = await lireSchema(await lire("/api/skins/perso").catch(() => null), schemaReponseListePerso);
  return d ? { nombre: d.skins.length, max: d.max } : null;
}

/** Supprime un habillage du compte (id sans préfixe) ; prévient la racine. */
export async function supprimerSkinPerso(id: string): Promise<boolean> {
  const r = await lire("/api/skins/perso/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) return false;
  window.dispatchEvent(new CustomEvent(EVT_SKINS_PERSO, { detail: {} }));
  return true;
}

const MAX_LIBELLE_CORRECTION = 40;
const MAX_LIGNE_CORRECTION = 160;
const COURT = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const HORS_LISTE = /inconnue\.$|hors de la liste/;

/** Texte ajouté au brouillon (jamais envoyé) : erreurs et contrastes en échec, libellé tronqué, clés inconnues comptées sans être recopiées. */
export function messageCorrection(corps: CorpsPerso, rapport: RapportPerso): string {
  const inconnues = rapport.erreurs.filter((e) => HORS_LISTE.test(e)).length;
  const lignes = [
    `L'habillage « ${COURT(nomSkin(corps), MAX_LIBELLE_CORRECTION)} » ne passe pas la vérification. Corrige et renvoie le bloc elpis-skin COMPLET.`,
    "",
    "Erreurs :",
    ...rapport.erreurs.filter((e) => !HORS_LISTE.test(e)).map((e) => "- " + COURT(e, MAX_LIGNE_CORRECTION)),
  ];
  if (inconnues)
    lignes.push(`- ${inconnues} clé(s) ou jeton(s) hors de la liste admise (voir le skill apparence).`);
  const mauvais = rapport.contrastes.filter((c) => !c.ok);
  if (mauvais.length) {
    lignes.push("", "Contrastes en échec :");
    for (const c of mauvais)
      lignes.push(
        `- ${c.paire} (${c.mode === "light" ? "clair" : "sombre"}) : ${c.ratio}:1, ${c.seuil}:1 exigé`,
      );
  }
  return lignes.join("\n");
}

/** Texte de correction d'un bloc elpis-skin qui n'a pas pu être lu (JSON invalide). */
export function messageBlocIllisible(erreur: string): string {
  return `Le bloc elpis-skin n'est pas lisible : ${COURT(erreur, MAX_LIGNE_CORRECTION)} Corrige et renvoie le bloc elpis-skin COMPLET.`;
}

/** Prévient la racine d'ajouter `texte` au brouillon du composeur. */
export function demanderCorrection(texte: string): void {
  window.dispatchEvent(new CustomEvent(EVT_SKIN_CORRECTION, { detail: { texte } }));
}

/** Brouillon du composeur augmenté du texte de correction, séparé par une ligne vide ; le brouillon existant est gardé. */
export function brouillonAvecCorrection(brouillon: string, texte: string): string {
  return brouillon.trim() ? brouillon.replace(/\s+$/, "") + "\n\n" + texte : texte;
}

export interface EtatApercuSkin {
  nom: string;
  darkBase: boolean;
  pastilles: string[];
  /** Feuille validée par le serveur (vide en cas d'erreur de structure). */
  css: string;
  /** Présents pour un bloc du chat (importable) ; absents pour un habillage déjà enregistré. */
  corps?: CorpsPerso;
  rapport?: RapportPerso;
}

/** Habillage montré par la modale d'aperçu (la même pour la carte du chat et Paramètres). */
export const apercuSkin = shallowRef<EtatApercuSkin | null>(null);

/** Aperçu d'un bloc du chat : corps et rapport du serveur. */
export function ouvrirApercuSkin(corps: CorpsPerso, rapport: RapportPerso): void {
  apercuSkin.value = {
    nom: nomSkin(corps),
    darkBase: corps.darkBase === true,
    pastilles: pastillesSkin(corps),
    css: rapport.css,
    corps,
    rapport,
  };
}

/** Aperçu d'un habillage enregistré : sa feuille est relue sur le serveur (propriétaire seul). */
export async function ouvrirApercuEnregistre(skin: {
  label: string;
  sw: string[];
  darkBase?: boolean;
  css_url?: string;
}): Promise<boolean> {
  const r = skin.css_url ? await lire(skin.css_url).catch(() => null) : null;
  if (!r || !r.ok) return false;
  apercuSkin.value = {
    nom: skin.label,
    darkBase: skin.darkBase === true,
    pastilles: skin.sw,
    css: await r.text(),
  };
  return true;
}

export function fermerApercuSkin(): void {
  apercuSkin.value = null;
}

const EMPLACEMENT_JETONS = '<style id="elpis-jetons"></style>';
const CORPS_APERCU = '<body class="elpis-skin-perso">';
let artefactApercu: string | null = null;

/** Oublie la maquette lue (tests, ou skill livré mis à jour). */
export function oublierArtefactApercu(): void {
  artefactApercu = null;
}

/** Maquette `assets/apercu.html` du skill livré `apparence` (lue une fois) ; `null` si introuvable. */
export async function lireArtefactApercu(): Promise<string | null> {
  if (artefactApercu !== null) return artefactApercu;
  const r = await lire("/api/skills/file?id=apparence&path=assets/apercu.html&scope=global").catch(
    () => null,
  );
  if (!r || !r.ok) return null;
  const d = await corpsJson(r);
  const contenu = estObjet(d) ? d["content"] : null;
  if (typeof contenu !== "string" || !contenu.includes(EMPLACEMENT_JETONS) || !contenu.includes(CORPS_APERCU))
    return null;
  artefactApercu = contenu;
  return contenu;
}

/** Maquette remplie de la feuille validée par le serveur, en clair ou en sombre. */
export function composerApercu(maquette: string, css: string, sombre: boolean): string {
  const sure = css.replace(/<\//g, "<\\/");
  return maquette
    .replace(EMPLACEMENT_JETONS, () => '<style id="elpis-jetons">' + sure + "</style>")
    .replace(CORPS_APERCU, () => (sombre ? '<body class="elpis-skin-perso elpis-app-dark">' : CORPS_APERCU));
}
