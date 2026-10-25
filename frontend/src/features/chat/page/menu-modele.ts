// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/menu-modele.ts — menu du modèle (interface nouvelle) : nom lisible tiré de l'identifiant, groupes par serveur avec leur état, lignes avec les capacités connues, l'état en texte et les actions, recherche. */
import { fmtTokenCount } from "../../../utils/utils-purs";
import type { ConnecteurLlm, DomaineModeles } from "./types";

const EXTENSION = /\.(?:gguf|bin|safetensors)$/i;
const MORCEAU = /-\d{5}-of-\d{5}$/i;
const QUANTIFICATION =
  /^(?:i?q\d+(?:_[a-z0-9]+)*|b?f16|f32|fp(?:4|8|16)|int[48]|awq|gptq|gguf|mlx|exl2|nf4|\d+bit)$/i;
const RETIRES: ReadonlySet<string> = new Set(["instruct", "it", "latest", "hf"]);
const MARQUES: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  gpt: "GPT",
  glm: "GLM",
  oss: "OSS",
  vl: "VL",
  moe: "MoE",
  llava: "LLaVA",
  minicpm: "MiniCPM",
  internlm: "InternLM",
  smollm: "SmolLM",
  olmo: "OLMo",
};

function motLisible(mot: string): string {
  const bas = mot.toLowerCase();
  const marque = MARQUES[bas];
  if (marque) return marque;
  if (/^\d+x\d+(?:\.\d+)?[bm]$/i.test(mot)) return bas.slice(0, -1) + bas.slice(-1).toUpperCase();
  if (/^(?:a?\d+(?:\.\d+)?[kmbt]|[rvk]\d+(?:\.\d+)?)$/i.test(mot)) return mot.toUpperCase();
  return mot === bas ? mot.charAt(0).toUpperCase() + mot.slice(1) : mot;
}

/** « qwen3-coder-30b-a3b-instruct-q4_k_m » devient « Qwen3 Coder 30B A3B » ; l'identifiant brut si rien ne reste. */
export function nomLisible(id: string): string {
  const base = (id.split("/").pop() ?? "")
    .replace(EXTENSION, "")
    .replace(MORCEAU, "")
    .replace(/\.(?=i?q\d)/i, "-");
  const mots = base
    .split(/[-\s:]+/)
    .filter((m) => m && !QUANTIFICATION.test(m))
    .flatMap((m) => m.split("_"))
    .filter((m) => m && !RETIRES.has(m.toLowerCase()));
  return mots.map(motLisible).join(" ") || id;
}

/** « 32 k » pour 32 768 (multiple de 1 024), « 200 k » pour 200 000. */
export function tailleContexte(n: number): string {
  if (n >= 1048576 && n % 1048576 === 0) return `${n / 1048576} M`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} k`;
  return fmtTokenCount(n);
}

export interface Capacite {
  libelle: string;
  titre: string;
}

export interface CapacitesConnues {
  contexte?: number;
  reflexion?: boolean;
  vision?: boolean;
  gratuit?: boolean;
}

/** Seulement ce que le serveur a dit du modèle ; rien n'est deviné. */
export function capacites(c: CapacitesConnues): Capacite[] {
  const sortie: Capacite[] = [];
  if (c.reflexion) sortie.push({ libelle: "Réflexion", titre: "Le modèle réfléchit avant de répondre" });
  if (c.vision) sortie.push({ libelle: "Vision", titre: "Le modèle lit les images" });
  if (c.contexte && c.contexte > 0)
    sortie.push({
      libelle: tailleContexte(c.contexte),
      titre: `Contexte de ${c.contexte.toLocaleString("fr-FR")} jetons`,
    });
  if (c.gratuit) sortie.push({ libelle: "Gratuit", titre: "Modèle sans facturation chez ce fournisseur" });
  return sortie;
}

export type EtatModele = "charge" | "disponible" | "echec" | "chargement" | "dechargement" | "inconnu";

export const LIBELLES_ETAT: Readonly<Record<EtatModele, string>> = {
  charge: "Chargé",
  disponible: "Disponible",
  echec: "Échec",
  chargement: "Chargement…",
  dechargement: "Déchargement…",
  inconnu: "—",
};

export interface ActionModele {
  id: "fiche" | "charger" | "decharger";
  libelle: string;
  icone: string;
}

const FICHE: ActionModele = { id: "fiche", libelle: "Fiche du modèle", icone: "ph-info" };
const CHARGER: ActionModele = { id: "charger", libelle: "Charger", icone: "ph-play" };
const DECHARGER: ActionModele = { id: "decharger", libelle: "Décharger", icone: "ph-eject" };

export interface LigneModele {
  cle: string;
  id: string;
  nom: string;
  connecteur: ConnecteurLlm | null;
  choisi: boolean;
  etat: EtatModele;
  capacites: Capacite[];
  actions: ActionModele[];
  attenue: boolean;
}

export interface EtatServeur {
  libelle: string;
  ton: "ok" | "neutre";
  reessayer: boolean;
}

export interface GroupeModeles {
  cle: string;
  nom: string;
  detail: string;
  connecteur: ConnecteurLlm | null;
  etat: EtatServeur;
  message: string;
  lignes: LigneModele[];
}

export type SourceMenu = Pick<
  DomaineModeles,
  | "selectedModel"
  | "selectedConnector"
  | "selectedEngineMeta"
  | "builtinAllowed"
  | "chargementIntegre"
  | "moteurIntegre"
  | "llmHealth"
  | "availableModels"
  | "modelsLoading"
  | "modelsError"
  | "isLoadingModel"
  | "modelLoadingId"
  | "pickerConnectors"
  | "pickerConnState"
  | "pickerConnModels"
  | "pickerConnFree"
  | "pickerConnLoading"
  | "modelesVision"
  | "effectiveParamsData"
  | "isModelFailed"
  | "isModelLoaded"
  | "isConnModelLoaded"
>;

const EN_LIGNE: EtatServeur = { libelle: "En ligne", ton: "ok", reessayer: false };
const INJOIGNABLE: EtatServeur = { libelle: "Injoignable", ton: "neutre", reessayer: true };
const INCONNU: EtatServeur = { libelle: "", ton: "neutre", reessayer: false };

function enMouvement(s: SourceMenu, cle: string, id: string): EtatModele | null {
  if (s.isLoadingModel !== cle) return null;
  return s.modelLoadingId === id ? "chargement" : "dechargement";
}

const reflechit = (s: SourceMenu): boolean =>
  s.effectiveParamsData?.supports_thinking === true && s.effectiveParamsData.model_id === s.selectedModel;

function groupeIntegre(s: SourceMenu): GroupeModeles {
  const sante = s.llmHealth;
  const nCtx = Number(sante?.props?.n_ctx) || 0;
  const declare = sante?.props?.model;
  // La fenêtre lue sur /props est celle du premier modèle chargé.
  const ctxDe = typeof declare === "string" && declare ? declare : "";
  const lignes = s.availableModels.map((id): LigneModele => {
    const choisi = !s.selectedConnector && s.selectedModel === id;
    const charge = s.isModelLoaded(id);
    const etat = enMouvement(s, id, id) ?? (s.isModelFailed(id) ? "echec" : charge ? "charge" : "disponible");
    const actions: ActionModele[] = charge ? [FICHE] : [];
    if (s.chargementIntegre) actions.push(charge ? DECHARGER : CHARGER);
    return {
      cle: "builtin|" + id,
      id,
      nom: nomLisible(id),
      connecteur: null,
      choisi,
      etat,
      capacites: capacites({
        contexte: id === ctxDe || (!ctxDe && charge && s.availableModels.length === 1) ? nCtx : 0,
        reflexion: choisi && reflechit(s),
        vision: s.modelesVision.includes(id),
      }),
      actions,
      attenue: false,
    };
  });
  const message = lignes.length
    ? ""
    : s.modelsLoading
      ? "Chargement des modèles…"
      : s.modelsError
        ? ""
        : "Aucun modèle";
  return {
    cle: "builtin",
    nom: "Serveur intégré",
    detail: s.modelsError || s.moteurIntegre?.libelle || "",
    connecteur: null,
    etat: sante?.server_reachable ? EN_LIGNE : sante || s.modelsError ? INJOIGNABLE : INCONNU,
    message,
    lignes,
  };
}

function etatLigneConnecteur(s: SourceMenu, conn: ConnecteurLlm, id: string): EtatModele {
  const st = s.pickerConnState[conn.id];
  const mouvement = enMouvement(s, "conn:" + conn.id + "|" + id, id);
  if (mouvement) return mouvement;
  if (!st || st.ok === false) return "inconnu";
  const statut = st.statuses?.[id];
  if (statut === "loaded") return "charge";
  if (statut === "loading") return "chargement";
  if (statut === "failed") return "echec";
  if (statut) return "disponible";
  // Sans inventaire : llama.cpp sans routeur, vLLM et SGLang servent ce qu'ils annoncent.
  return !st.router && (st.providerType === "llamacpp" || st.moteur?.chargement === false)
    ? "charge"
    : "disponible";
}

function groupeConnecteur(s: SourceMenu, conn: ConnecteurLlm): GroupeModeles {
  const st = s.pickerConnState[conn.id];
  const enCours = !!s.pickerConnLoading[conn.id];
  const ids = s.pickerConnModels[conn.id] ?? [];
  const gerable = !!st?.router && !!st.canManage;
  const lignes = ids.map((id): LigneModele => {
    const choisi = s.selectedConnector === conn.id && s.selectedModel === id;
    const charge = s.isConnModelLoaded(conn.id, id);
    const actions: ActionModele[] = charge ? [FICHE] : [];
    if (gerable) actions.push(charge ? DECHARGER : CHARGER);
    const contexte = choisi ? Number(s.selectedEngineMeta?.n_ctx) || 0 : ids.length === 1 ? st?.nCtx : 0;
    return {
      cle: "conn:" + conn.id + "|" + id,
      id,
      nom: nomLisible(id),
      connecteur: conn,
      choisi,
      etat: etatLigneConnecteur(s, conn, id),
      capacites: capacites({
        contexte,
        reflexion: choisi && reflechit(s),
        gratuit: !!s.pickerConnFree[conn.id]?.[id],
      }),
      actions,
      attenue: st?.ok === false,
    };
  });
  const etat: EtatServeur = st
    ? st.ok === false
      ? INJOIGNABLE
      : EN_LIGNE
    : enCours
      ? { libelle: "Connexion…", ton: "neutre", reessayer: false }
      : INCONNU;
  const partage = conn.scope === "shared" ? "Partagé" : "";
  return {
    cle: "conn:" + conn.id,
    nom: conn.label || conn.provider_type || "Serveur",
    detail: [st?.ok === false ? st.error : "", partage, conn.base_url ?? ""].filter(Boolean).join(" · "),
    connecteur: conn,
    etat,
    message: st && st.ok !== false && !ids.length && !enCours ? "Aucun modèle" : "",
    lignes,
  };
}

/** Serveur intégré (s'il est permis) puis un groupe par connecteur, dans l'ordre du serveur. */
export function construireGroupes(s: SourceMenu): GroupeModeles[] {
  const groupes = s.pickerConnectors.map((c) => groupeConnecteur(s, c));
  return s.builtinAllowed ? [groupeIntegre(s), ...groupes] : groupes;
}

const sansAccent = (t: string): string =>
  t
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Lignes dont le nom, l'identifiant ou le serveur contient la recherche, sans accent ni casse. */
export function filtrerGroupes(groupes: readonly GroupeModeles[], recherche: string): GroupeModeles[] {
  const q = sansAccent(recherche.trim());
  if (!q) return [...groupes];
  return groupes
    .map((g) => ({
      ...g,
      message: "",
      lignes: g.lignes.filter((l) => sansAccent(`${l.nom} ${l.id} ${g.nom}`).includes(q)),
    }))
    .filter((g) => g.lignes.length > 0);
}

/** Au-delà de ce nombre de modèles, le menu offre une recherche. */
export const SEUIL_RECHERCHE = 6;
