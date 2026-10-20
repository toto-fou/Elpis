// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/commande.ts — commande `/rag` du chat : sous-commandes (use, off, search, add, new, status, open), menus des sous-commandes et des collections, résolution d'un nom de collection, messages d'erreur clairs, notice de recherche. */
import type { CollectionVueRag, PassageTrouveRag, ResultatDepotRag, TravailRag } from "@elpis/contracts";
import type { Ref } from "vue";

import type { PieceJointe } from "../chat/composeur/composeur";
import type { ApiRag, ResultatRag } from "./api";
import { bilanDepot, corpsDepot, decouperEnLots, phraseBilan, preparerDepot } from "./depot";
import { accorder, pourcentage } from "./format";
import { KIND_NOTICE_RECHERCHE, creerNotice, fusionnerPassages, serialiserNotice } from "./notice-recherche";

export interface ValeurMenuRag {
  value: string;
  label: string;
  /** Argument attendu, écrit entre parenthèses après la valeur : `(collection)`. */
  indice?: string;
  icone?: string;
}

/** Même forme que le résultat d'une commande « / » du composeur. */
export interface ResultatCommandeRag {
  ok: boolean;
  msg?: string;
  info?: boolean;
  silent?: boolean;
}

/** Ce que `/rag` lit du chat (monté avant lui) : collections actives, pièces jointes, fil. */
export interface ChatPourRag {
  readonly ragChat: {
    /** Faux : le compte n'a pas le droit RAG (la commande disparaît). */
    readonly autorise: Ref<boolean | null>;
    readonly selection: Ref<readonly string[]>;
    readonly accessibles: Ref<readonly CollectionVueRag[]>;
    rafraichir(): Promise<void>;
    activer(id: string): Promise<boolean>;
    couper(): Promise<boolean>;
  };
  readonly attachedFiles: Ref<PieceJointe[]>;
  readonly messages: Ref<unknown[]>;
  readonly defilerEnBas?: () => void;
}

export interface DepsCommandeRag {
  readonly api: ApiRag;
  readonly chat: () => ChatPourRag | null;
  /** Ouvre la page RAG, sur une collection si un identifiant est donné. */
  readonly ouvrirPage: (id?: string) => Promise<void> | void;
  readonly enGeneration: () => boolean;
  /** Avis aux menus du chat : une collection a été créée ou enrichie. */
  readonly notifierCollections: () => void;
  readonly maintenant?: () => number;
}

export const SOUS_COMMANDES: readonly ValeurMenuRag[] = [
  {
    value: "use",
    indice: "collection",
    label: "Interroger une collection dans ce chat",
    icone: "ph-caret-right",
  },
  { value: "off", label: "Ne plus interroger de collection", icone: "ph-caret-right" },
  {
    value: "search",
    indice: "question",
    label: "Montrer les passages, sans réponse de l’assistant",
    icone: "ph-caret-right",
  },
  {
    value: "add",
    indice: "collection",
    label: "Indexer les fichiers joints dans une collection",
    icone: "ph-caret-right",
  },
  {
    value: "new",
    indice: "nom",
    label: "Créer une collection avec les fichiers joints",
    icone: "ph-caret-right",
  },
  { value: "status", label: "Voir les indexations en cours", icone: "ph-caret-right" },
  { value: "open", label: "Ouvrir la page RAG", icone: "ph-caret-right" },
];

const NOMS_SOUS = SOUS_COMMANDES.map((s) => s.value);

/** Titre du menu des valeurs selon la sous-commande déjà choisie. */
export function titreMenu(avant: readonly string[]): string {
  switch (avant[0]) {
    case "use":
      return "Collection à interroger";
    case "add":
      return "Collection à enrichir";
    case "open":
      return "Collection à ouvrir";
    default:
      return "RAG";
  }
}

/** La saisie après `/rag` : sous-commande et reste de la ligne. */
export function analyserSaisie(raw: string): { sous: string; reste: string } {
  const t = raw.trim();
  const i = t.search(/\s/u);
  return i < 0
    ? { sous: t.toLowerCase(), reste: "" }
    : { sous: t.slice(0, i).toLowerCase(), reste: t.slice(i).trim() };
}

const norme = (s: string): string => s.normalize("NFC").trim().toLowerCase();
const auteurDe = (c: CollectionVueRag): string => c.owner.display_name || c.owner.username;

/** Collections lisibles, les miennes d'abord puis celles partagées avec moi, chaque groupe par nom (maquette 08). */
export function ordonnerCollections(liste: readonly CollectionVueRag[]): CollectionVueRag[] {
  const mes = liste.filter((c) => c.role === "proprietaire").sort((a, b) => a.name.localeCompare(b.name));
  const autres = liste
    .filter((c) => c.role !== "proprietaire")
    .sort((a, b) => a.name.localeCompare(b.name) || auteurDe(a).localeCompare(auteurDe(b)));
  return [...mes, ...autres];
}

/** Nom qui désigne une collection : son nom, suivi de l'auteur entre parenthèses quand un autre nom identique existe. */
export function libelleCollection(c: CollectionVueRag, toutes: readonly CollectionVueRag[]): string {
  const doublon = toutes.some((x) => x.id !== c.id && norme(x.name) === norme(c.name));
  return doublon && c.role === "lecteur" ? `${c.name} (${auteurDe(c)})` : c.name;
}

/** Détail d'une ligne du menu : « Vous · publiée · 17 documents », « Sophie Laurent · 128 documents ». */
export function detailCollection(c: CollectionVueRag): string {
  const parts = [c.role === "proprietaire" ? "Vous" : auteurDe(c)];
  if (c.role === "proprietaire" && c.visibility !== "private") parts.push("publiée");
  parts.push(accorder(c.doc_count, "document"));
  return parts.join(" · ");
}

/** Lignes du menu des collections : les miennes puis celles partagées ; `miennes` ne garde que les miennes. */
export function valeursCollections(liste: readonly CollectionVueRag[], miennes = false): ValeurMenuRag[] {
  const toutes = ordonnerCollections(liste);
  return toutes
    .filter((c) => !miennes || c.role === "proprietaire")
    .map((c) => ({
      value: libelleCollection(c, toutes),
      label: detailCollection(c),
      icone: c.role === "proprietaire" ? "ph-books" : "ph-users-three",
    }));
}

export type ResolutionCollection =
  | { ok: true; collection: CollectionVueRag }
  | { ok: false; code: "vide" | "inconnue" | "ambigue" | "lecture_seule"; message: string };

/** Collection désignée par une saisie : nom (casse et accents d'écriture libres), « nom (auteur) », identifiant, ou début de nom unique. `miennes` refuse celles d'autrui. */
export function resoudreCollection(
  saisie: string,
  liste: readonly CollectionVueRag[],
  miennes = false,
): ResolutionCollection {
  const q = norme(saisie);
  if (q === "") return { ok: false, code: "vide", message: "Précisez une collection." };
  const toutes = ordonnerCollections(liste);
  let trouvees = toutes.filter(
    (c) => c.id === q || norme(c.name) === q || norme(libelleCollection(c, toutes)) === q,
  );
  if (trouvees.length === 0) trouvees = toutes.filter((c) => norme(c.name).startsWith(q));
  if (trouvees.length === 0)
    return {
      ok: false,
      code: "inconnue",
      message: `Collection inconnue : « ${saisie.trim()} ». Tapez /rag use pour voir celles que vous pouvez interroger.`,
    };
  const miennesTrouvees = trouvees.filter((c) => c.role === "proprietaire");
  if (miennes) {
    const seule = miennesTrouvees[0];
    if (miennesTrouvees.length === 1 && seule !== undefined) return { ok: true, collection: seule };
    if (miennesTrouvees.length > 1) return ambigue();
    const autre = trouvees[0] as CollectionVueRag;
    return {
      ok: false,
      code: "lecture_seule",
      message: `« ${autre.name} » est partagée par ${auteurDe(autre)} en lecture seule : choisissez une de vos collections.`,
    };
  }
  const un =
    trouvees.length === 1 ? trouvees[0] : miennesTrouvees.length === 1 ? miennesTrouvees[0] : undefined;
  return un !== undefined ? { ok: true, collection: un } : ambigue();
}

function ambigue(): ResolutionCollection {
  return {
    ok: false,
    code: "ambigue",
    message: "Plusieurs collections portent ce nom : précisez « nom (auteur) ».",
  };
}

const MESSAGES: Readonly<Record<string, string>> = {
  rag_interdit: "Le RAG n’est pas ouvert à votre compte.",
  rag_desactive: "Le RAG est désactivé : le serveur d’embeddings n’est pas configuré.",
  collection_introuvable: "Collection introuvable : elle a peut-être été supprimée.",
  lecture_seule: "Cette collection est en lecture seule : seul son auteur peut la modifier.",
  nom_deja_pris: "Vous avez déjà une collection de ce nom.",
  quota_collections: "Vous avez atteint le nombre maximal de collections.",
  quota_stockage: "Votre quota de stockage RAG est atteint.",
  quota_documents: "Cette collection a atteint son nombre maximal de documents.",
  fichier_trop_gros: "Un fichier dépasse la taille permise par fichier.",
  extension_refusee: "Format de fichier non pris en charge.",
  sandbox_indisponible: "La sandbox est indisponible : les fichiers cités n’ont pas pu être lus.",
  qdrant_indisponible: "La base vectorielle est indisponible.",
  embeddings_indisponibles: "Le serveur d’embeddings est injoignable.",
  recherche_impossible: "La recherche a échoué.",
};

type Echec = Extract<ResultatRag<unknown>, { ok: false }>;

/** Phrase dite pour un échec d'appel : le code connu d'abord, sinon le message du serveur. */
export function messageEchec(r: Echec, parDefaut: string): string {
  return (r.code !== null ? MESSAGES[r.code] : undefined) ?? (r.message !== "" ? r.message : parDefaut);
}

const LIMITE_RECHERCHE = 8;
const nombre = (n: number, mot: string): string => `${n} ${mot}${n > 1 ? "s" : ""}`;

interface PiecesClassees {
  fichiers: File[];
  chemins: string[];
  ignorees: number;
}

/** Pièces jointes d'un message selon ce que le RAG en fait : fichiers à déposer, chemins de la sandbox (@) à importer, le reste (images…) ignoré. */
export function classerPieces(pieces: readonly PieceJointe[]): PiecesClassees {
  const sortie: PiecesClassees = { fichiers: [], chemins: [], ignorees: 0 };
  for (const p of pieces) {
    if (p.isImage) sortie.ignorees++;
    else if (p.isMention) sortie.chemins.push(p.name);
    else if (p.fichier instanceof File) sortie.fichiers.push(p.fichier);
    else sortie.ignorees++;
  }
  return sortie;
}

function bilanPhrase(resultats: readonly ResultatDepotRag[], nom: string, ignorees: number): string {
  const b = bilanDepot(resultats);
  const refus = resultats.find((r) => r.status === "refuse");
  const parts = [`« ${nom} » : ${phraseBilan(b) || "rien à indexer"}.`];
  if (refus?.message) parts.push(`Refusé : ${refus.name} (${refus.message}).`);
  if (ignorees > 0)
    parts.push(
      `${nombre(ignorees, "pièce jointe")} ignorée${ignorees > 1 ? "s" : ""} (images ou fichiers non pris en charge).`,
    );
  if (b.ajoutes + b.remplaces > 0) parts.push("L’indexation démarre : /rag status pour la suivre.");
  return parts.join(" ");
}

export function creerCommandeRag(dep: DepsCommandeRag) {
  const { api } = dep;
  const maintenant = dep.maintenant ?? ((): number => Date.now());
  let derniereLecture = 0;

  const collections = (): readonly CollectionVueRag[] => dep.chat()?.ragChat.accessibles.value ?? [];

  /** Faux seulement quand le serveur a refusé le RAG au compte : la commande n'est alors pas proposée. */
  const disponible = (): boolean => dep.chat()?.ragChat.autorise.value !== false;

  /** Les menus se nourrissent de la liste du chat, relue au plus toutes les 10 s quand `/rag` est tapé. */
  function actualiser(): void {
    const chat = dep.chat();
    if (chat === null || maintenant() - derniereLecture < 10_000) return;
    derniereLecture = maintenant();
    void chat.ragChat.rafraichir();
  }

  function valeurs(avant: readonly string[]): readonly ValeurMenuRag[] {
    const sous = avant[0];
    if (sous === undefined) return SOUS_COMMANDES;
    if (sous === "use" || sous === "open") return valeursCollections(collections());
    if (sous === "add") return valeursCollections(collections(), true);
    return [];
  }

  /** Une collection d'après la saisie ; la liste est relue une fois si elle ne la connaît pas. */
  async function trouver(saisie: string, miennes: boolean): Promise<ResolutionCollection> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, code: "inconnue", message: "Le chat n’est pas prêt." };
    let r = resoudreCollection(saisie, chat.ragChat.accessibles.value, miennes);
    if (!r.ok && (r.code === "inconnue" || r.code === "lecture_seule")) {
      await chat.ragChat.rafraichir();
      derniereLecture = maintenant();
      r = resoudreCollection(saisie, chat.ragChat.accessibles.value, miennes);
    }
    return r;
  }

  async function utiliser(reste: string): Promise<ResultatCommandeRag> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, msg: "Le chat n’est pas prêt." };
    if (reste === "") return { ok: false, msg: "Précisez une collection : /rag use <collection>." };
    const r = await trouver(reste, false);
    if (!r.ok) return { ok: false, msg: r.message };
    const c = r.collection;
    if (chat.ragChat.selection.value.includes(c.id))
      return { ok: true, info: true, msg: `« ${c.name} » est déjà interrogée dans ce chat.` };
    // Un refus du serveur est déjà dit par l'API des collections actives (toast).
    if (!(await chat.ragChat.activer(c.id))) return { ok: false, silent: true };
    return { ok: true, msg: `« ${c.name} » sera interrogée dans ce chat.` };
  }

  async function couper(): Promise<ResultatCommandeRag> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, msg: "Le chat n’est pas prêt." };
    if (chat.ragChat.selection.value.length === 0)
      return { ok: true, info: true, msg: "Aucune collection n’est interrogée dans ce chat." };
    if (!(await chat.ragChat.couper())) return { ok: false, silent: true };
    return { ok: true, msg: "Ce chat n’interroge plus de collection." };
  }

  async function chercher(question: string): Promise<ResultatCommandeRag> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, msg: "Le chat n’est pas prêt." };
    if (question === "") return { ok: false, msg: "Précisez une question : /rag search <question>." };
    if (dep.enGeneration())
      return { ok: false, msg: "Une génération est en cours : attendez sa fin pour chercher." };
    const ids = [...chat.ragChat.selection.value];
    if (ids.length === 0)
      return { ok: false, msg: "Aucune collection active dans ce chat : choisissez-en une avec /rag use." };
    const debut = maintenant();
    const reponses = await Promise.all(
      ids.map(async (id) => ({
        id,
        r: await api.rechercher(id, {
          requete: question,
          mode: "mixte",
          limite: LIMITE_RECHERCHE,
          reclasser: false,
        }),
      })),
    );
    const nom = (id: string): string => collections().find((c) => c.id === id)?.name ?? "Collection";
    const reussies: { id: string; passages: PassageTrouveRag[]; mode: string }[] = [];
    const erreurs: string[] = [];
    for (const { id, r } of reponses) {
      if (r.ok) reussies.push({ id, passages: r.valeur.passages, mode: r.valeur.mode });
      else erreurs.push(`« ${nom(id)} » : ${messageEchec(r, "recherche impossible")}`);
    }
    if (reussies.length === 0) return { ok: false, msg: erreurs[0] ?? "La recherche a échoué." };
    const passages = fusionnerPassages(
      reussies.map((x) => x.passages),
      LIMITE_RECHERCHE,
    );
    const notice = creerNotice({
      requete: question,
      mode: reussies[0]?.mode ?? "mixte",
      duree_ms: Math.max(0, maintenant() - debut),
      collections: ids.map((id) => ({ id, name: nom(id) })),
      passages,
      erreurs,
    });
    chat.messages.value.push(
      Object.freeze({
        role: "notice",
        kind: KIND_NOTICE_RECHERCHE,
        ts: maintenant() / 1000,
        summary: serialiserNotice(notice),
        content: "",
      }),
    );
    chat.defilerEnBas?.();
    return { ok: true, silent: true };
  }

  /** Dépose les fichiers joints et importe les `@fichiers` de la sandbox dans `c` ; `null` si rien n'est joint. */
  async function envoyer(c: CollectionVueRag, chat: ChatPourRag): Promise<ResultatCommandeRag | null> {
    const pieces = classerPieces(chat.attachedFiles.value);
    if (pieces.fichiers.length === 0 && pieces.chemins.length === 0) return null;
    const etat = await api.etat();
    if (etat.ok && !etat.valeur.usable)
      return {
        ok: false,
        msg: etat.valeur.reason?.message ?? MESSAGES["rag_desactive"] ?? "RAG indisponible.",
      };
    const resultats: ResultatDepotRag[] = [];
    if (pieces.fichiers.length > 0) {
      const prepare = preparerDepot(
        pieces.fichiers.map((file) => ({ file, chemin: file.name })),
        etat.ok ? etat.valeur.quotas.file_mb : 0,
      );
      resultats.push(...prepare.refus);
      for (const lot of decouperEnLots(prepare.aEnvoyer)) {
        const r = await api.deposer(c.id, corpsDepot(lot));
        if (!r.ok) return { ok: false, msg: messageEchec(r, "Le dépôt a échoué.") };
        resultats.push(...r.valeur.results);
      }
    }
    if (pieces.chemins.length > 0) {
      const r = await api.importerBac(c.id, pieces.chemins);
      if (!r.ok) return { ok: false, msg: messageEchec(r, "L’import depuis la sandbox a échoué.") };
      resultats.push(...r.valeur.results);
    }
    const b = bilanDepot(resultats);
    const accepte = b.ajoutes + b.remplaces + b.dejaPresents > 0;
    if (accepte) chat.attachedFiles.value = [];
    dep.notifierCollections();
    return { ok: accepte, msg: bilanPhrase(resultats, c.name, pieces.ignorees) };
  }

  async function ajouter(reste: string): Promise<ResultatCommandeRag> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, msg: "Le chat n’est pas prêt." };
    if (reste === "") return { ok: false, msg: "Précisez une collection : /rag add <collection>." };
    const r = await trouver(reste, true);
    if (!r.ok) return { ok: false, msg: r.message };
    const sortie = await envoyer(r.collection, chat);
    return (
      sortie ?? {
        ok: false,
        msg: "Aucun fichier joint : joignez des fichiers avec le bouton + (5 Mo au plus) ou citez-en de la sandbox avec @, puis relancez /rag add.",
      }
    );
  }

  async function creer(reste: string): Promise<ResultatCommandeRag> {
    const chat = dep.chat();
    if (chat === null) return { ok: false, msg: "Le chat n’est pas prêt." };
    if (reste === "") return { ok: false, msg: "Donnez un nom : /rag new <nom>." };
    if (reste.length > 80) return { ok: false, msg: "Le nom d’une collection fait 80 caractères au plus." };
    const cree = await api.creer(reste, "");
    if (!cree.ok) return { ok: false, msg: messageEchec(cree, "La collection n’a pas pu être créée.") };
    dep.notifierCollections();
    const c = cree.valeur;
    const sortie = await envoyer(c, chat);
    if (sortie === null)
      return {
        ok: true,
        msg: `Collection « ${c.name} » créée. Ajoutez-y des documents avec /rag add ou depuis la page RAG.`,
      };
    return { ...sortie, msg: `Collection « ${c.name} » créée. ${sortie.msg}` };
  }

  async function statut(): Promise<ResultatCommandeRag> {
    const r = await api.travaux(true);
    if (!r.ok) return { ok: false, msg: messageEchec(r, "L’état des indexations n’a pas pu être lu.") };
    const jobs: TravailRag[] = r.valeur;
    if (jobs.length === 0) return { ok: true, info: true, msg: "Aucune indexation en cours." };
    const lignes = jobs.map((j) => {
      const nom = collections().find((c) => c.id === j.collection_id)?.name ?? "Collection";
      const fin = j.done + j.failed;
      const suspendu = j.status === "paused" ? ", suspendue" : j.status === "queued" ? ", en attente" : "";
      return `« ${nom} » ${fin}/${j.total} (${pourcentage(j.done, j.failed, j.total)} %${suspendu})`;
    });
    return {
      ok: true,
      info: true,
      msg: `${nombre(jobs.length, "indexation")} en cours : ${lignes.join(" · ")}.`,
    };
  }

  async function ouvrir(reste: string): Promise<ResultatCommandeRag> {
    if (reste === "") {
      await dep.ouvrirPage();
      return { ok: true, silent: true };
    }
    const r = await trouver(reste, false);
    if (!r.ok) return { ok: false, msg: r.message };
    await dep.ouvrirPage(r.collection.id);
    return { ok: true, silent: true };
  }

  async function lancer(raw: string): Promise<ResultatCommandeRag> {
    const { sous, reste } = analyserSaisie(raw);
    switch (sous) {
      case "":
        return {
          ok: true,
          info: true,
          msg: `Sous-commandes de /rag : ${NOMS_SOUS.join(", ")}.`,
        };
      case "use":
        return utiliser(reste);
      case "off":
        return couper();
      case "search":
        return chercher(reste);
      case "add":
        return ajouter(reste);
      case "new":
        return creer(reste);
      case "status":
        return statut();
      case "open":
        return ouvrir(reste);
      default:
        return {
          ok: false,
          msg: `Sous-commande inconnue : « ${sous} ». Essayez ${NOMS_SOUS.join(", ")}.`,
        };
    }
  }

  return { disponible, valeurs, actualiser, lancer };
}

export type CommandeRag = ReturnType<typeof creerCommandeRag>;
