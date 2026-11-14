// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/chat.ts — secrets attachés à la conversation : puces `secret:<name>` (chat existant : `PUT /api/chats/:id/secrets`, une requête à la fois et réponses d'un autre chat ignorées ; chat neuf : sélection gardée puis envoyée avec le premier tour) et commande `/secret` (liste, attach, detach, complétion des noms). */
import { SECRETS_ATTACHES_MAX } from "@elpis/contracts";
import type { Secret } from "@elpis/contracts";
import { computed, ref } from "vue";
import type { Ref } from "vue";

import type { ApiSecrets } from "./api";
import { estAttachable, resumeSecret } from "./format";

/** Ligne d'un menu de la commande (même forme que les valeurs du menu « / »). */
export interface ValeurMenuSecret {
  value: string;
  label: string;
  indice?: string;
  icone?: string;
}

/** Même forme que le résultat d'une commande « / » du composeur. */
export interface ResultatCommandeSecret {
  ok: boolean;
  msg?: string;
  info?: boolean;
  silent?: boolean;
}

export interface DepsSecretsChat {
  readonly api: ApiSecrets;
  readonly currentChatId: Ref<string | null>;
  readonly toast: (message: string, type?: string) => void;
  readonly maintenant?: () => number;
}

export const SOUS_COMMANDES_SECRET: readonly ValeurMenuSecret[] = [
  { value: "attach", indice: "name…", label: "Attacher à la conversation", icone: "ph-link" },
  { value: "detach", indice: "name|--all", label: "Détacher", icone: "ph-link-break" },
];

/** Relecture des secrets du compte pour les menus : au plus une toutes les 10 s. */
const RELECTURE_MS = 10_000;

/** `/secret <verbe> <noms…>` : verbe en minuscules (vide = liste), noms sans doublon. */
export function analyserCommandeSecret(raw: string): { verbe: string; noms: string[] } {
  const mots = raw.trim().split(/\s+/u).filter(Boolean);
  const verbe = (mots[0] ?? "").toLowerCase();
  return { verbe, noms: [...new Set(mots.slice(1).map((m) => m.toLowerCase()))] };
}

const idsValides = (brut: unknown): number[] =>
  Array.isArray(brut)
    ? brut.filter((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0)
    : [];

/** Nouvel ensemble calculé sur l'ensemble courant, ou refus (`info` : rien à faire, sans erreur). */
type Calcul = (
  courants: readonly Secret[],
  chat: string | null,
) => readonly Secret[] | { readonly message: string; readonly info?: boolean };

/** Issue d'un changement : retenu, refusé, ou périmé (conversation changée entre-temps : rien à dire). */
type IssueEnsemble =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly info?: boolean }
  | { readonly ok: false; readonly perime: true };

const PERIME = { ok: false, perime: true } as const;
const memesIds = (a: readonly Secret[], b: readonly Secret[]): boolean =>
  a.length === b.length && a.every((s, i) => s.id === b[i]?.id);

export function creerSecretsChat(dep: DepsSecretsChat) {
  const maintenant = dep.maintenant ?? ((): number => Date.now());
  const attaches = ref<readonly Secret[]>([]);
  const compte = ref<readonly Secret[]>([]);
  let compteA = 0;
  let lecture: Promise<void> | null = null;
  /** Sélection faite sur un chat neuf, pas encore partie avec un tour. */
  let aSceller = false;
  /** Chat ouvert avec des secrets dont la lecture n'a pas encore abouti : les puces vides ne disent rien. */
  let inconnu = false;
  /** Lectures et écritures de l'ensemble attaché, une à la fois ; un changement de chat ouvre une nouvelle file. */
  let file: Promise<unknown> = Promise.resolve();
  let generation = 0;

  const disponibles = computed(() =>
    compte.value.filter((s) => estAttachable(s) && !attaches.value.some((a) => a.id === s.id)),
  );

  async function lireCompte(force = false): Promise<void> {
    if (lecture) return lecture;
    if (!force && compteA && maintenant() - compteA < RELECTURE_MS) return;
    lecture = (async () => {
      const r = await dep.api.lister("compte");
      if (r.ok) {
        compte.value = [...r.valeur].sort((a, b) => a.name.localeCompare(b.name));
        compteA = maintenant();
      }
    })().finally(() => {
      lecture = null;
    });
    return lecture;
  }

  /** Menus de `/secret` : secrets du compte relus au plus toutes les 10 s. */
  function actualiser(): void {
    void lireCompte();
  }

  /** Tâche mise en file : elle part après la précédente et sait si la conversation a changé depuis. */
  function enFile<T>(tache: (gen: number) => Promise<T>): Promise<T> {
    const gen = generation;
    const suite = file.then(
      () => tache(gen),
      () => tache(gen),
    );
    file = suite.catch(() => undefined);
    return suite;
  }

  function nouvelleConversation(): void {
    generation++;
    file = Promise.resolve();
    aSceller = false;
    inconnu = false;
    attaches.value = [];
  }

  const courante = (gen: number, chat: string | null): boolean =>
    gen === generation && dep.currentChatId.value === chat;

  /** Puces relues du serveur, après les changements en cours ; ignorées si le chat a changé. */
  function recharger(chatId: string): Promise<void> {
    return enFile(async (gen) => {
      if (!courante(gen, chatId)) return;
      const r = await dep.api.attaches(chatId);
      if (courante(gen, chatId) && r.ok) {
        attaches.value = r.valeur;
        inconnu = false;
      }
    });
  }

  /** Ensemble du chat relu si sa lecture à l'ouverture a échoué : rien n'est calculé sur des puces inconnues. */
  async function assurerEnsemble(gen: number, chat: string): Promise<IssueEnsemble | null> {
    if (!inconnu) return null;
    const r = await dep.api.attaches(chat);
    if (!courante(gen, chat)) return PERIME;
    if (!r.ok) return { ok: false, message: r.message || "Secrets de la conversation illisibles." };
    attaches.value = r.valeur;
    inconnu = false;
    return null;
  }

  /** Changement de l'ensemble calculé sur les puces à jour ; un secret supprimé ailleurs (`secret_unknown`) fait relire l'ensemble et rejouer le calcul une fois. */
  function muter(calcul: Calcul): Promise<IssueEnsemble> {
    return enFile(async (gen): Promise<IssueEnsemble> => {
      const chat = dep.currentChatId.value;
      if (gen !== generation) return PERIME;
      const avant = chat ? await assurerEnsemble(gen, chat) : null;
      if (avant) return avant;
      const liste = calcul(attaches.value, chat);
      if ("message" in liste) return { ok: false, ...liste };
      if (liste.length > SECRETS_ATTACHES_MAX)
        return { ok: false, message: `${SECRETS_ATTACHES_MAX} secrets au plus par conversation.` };
      if (!chat) {
        attaches.value = [...liste];
        aSceller = liste.length > 0;
        return { ok: true };
      }
      if (memesIds(liste, attaches.value)) return { ok: true };
      let r = await dep.api.attacher(
        chat,
        liste.map((s) => s.id),
      );
      if (!r.ok && r.code === "secret_unknown" && courante(gen, chat)) {
        const relu = await dep.api.attaches(chat);
        if (!courante(gen, chat)) return PERIME;
        if (relu.ok) {
          attaches.value = relu.valeur;
          const encore = calcul(relu.valeur, chat);
          if ("message" in encore) return { ok: false, ...encore };
          r = await dep.api.attacher(
            chat,
            encore.map((s) => s.id),
          );
        }
      }
      if (!courante(gen, chat)) return PERIME;
      if (!r.ok) return { ok: false, message: r.message || "Secrets non enregistrés." };
      attaches.value = r.valeur;
      aSceller = false;
      return { ok: true };
    });
  }

  /** Chat chargé : ses ids enregistrés (`secrets` de la conversation) ; métadonnées relues s'il y en a. */
  function appliquerDuChat(ids: unknown, chatId: string): void {
    nouvelleConversation();
    if (!chatId || !idsValides(ids).length) return;
    inconnu = true;
    void recharger(chatId);
  }

  function reinitialiser(): void {
    nouvelleConversation();
  }

  function vider(): void {
    reinitialiser();
    compte.value = [];
    compteA = 0;
  }

  /** Ids à envoyer avec le premier tour d'un chat neuf ; `null` : rien à sceller (l'ensemble du serveur reste). */
  function enAttente(): number[] | null {
    return aSceller && attaches.value.length ? attaches.value.map((s) => s.id) : null;
  }

  /** Premier tour accepté : le serveur a attaché l'ensemble avant le flux ; les puces sont relues de lui. */
  function envoyes(chatId: string): void {
    if (dep.currentChatId.value !== chatId) return;
    aSceller = false;
    void recharger(chatId);
  }

  /** Liste du compte changée ailleurs (Paramètres) : menus relus, puces resynchronisées. */
  function changementCompte(): void {
    compteA = 0;
    const chat = dep.currentChatId.value;
    if (chat && !aSceller && attaches.value.length) void recharger(chat);
  }

  async function detacher(id: number): Promise<void> {
    const r = await muter((courants) => courants.filter((s) => s.id !== id));
    if (!r.ok && !("perime" in r)) dep.toast(r.message, "error");
  }

  function valeurs(avant: readonly string[]): readonly ValeurMenuSecret[] {
    const verbe = avant[0];
    if (verbe === undefined) return SOUS_COMMANDES_SECRET;
    const deja = new Set(avant.slice(1).map((m) => m.toLowerCase()));
    if (verbe === "attach")
      return disponibles.value
        .filter((s) => !deja.has(s.name))
        .map((s) => ({ value: s.name, label: resumeSecret(s), icone: "ph-key" }));
    if (verbe === "detach" && attaches.value.length)
      return [
        { value: "--all", label: "Tout détacher", icone: "ph-link-break" },
        ...attaches.value
          .filter((s) => !deja.has(s.name))
          .map((s) => ({ value: s.name, label: resumeSecret(s), icone: "ph-key" })),
      ];
    return [];
  }

  async function lister(): Promise<ResultatCommandeSecret> {
    const [, ensemble] = await Promise.all([
      lireCompte(true),
      enFile((gen) => {
        const chat = dep.currentChatId.value;
        return chat ? assurerEnsemble(gen, chat) : Promise.resolve(null);
      }),
    ]);
    if (ensemble) return resultat(ensemble, "");
    const noms = (l: readonly Secret[]): string => l.map((s) => s.name).join(", ") || "aucun";
    return {
      ok: true,
      info: true,
      msg: `Attachés : ${noms(attaches.value)} · disponibles : ${noms(disponibles.value)}`,
    };
  }

  /** Chat neuf : aucun appel pour l'en juger, la règle du serveur (genre du navigateur, vérifié) est appliquée ici. */
  function refusLocal(s: Secret): string | null {
    if (s.kind !== "web-login" && s.kind !== "http-auth")
      return `${s.name} : type ${s.kind}, seuls web-login et http-auth s'attachent.`;
    if (s.state !== "active") return `${s.name} : unverified, à vérifier dans Paramètres › Secrets.`;
    return null;
  }

  /** Résultat de la commande pour une issue : une issue périmée (chat changé) ne dit rien. */
  function resultat(r: IssueEnsemble, succes: string): ResultatCommandeSecret {
    if (r.ok) return { ok: true, msg: succes };
    if ("perime" in r) return { ok: false, silent: true };
    return r.info ? { ok: true, info: true, msg: r.message } : { ok: false, msg: r.message };
  }

  async function attacher(noms: readonly string[]): Promise<ResultatCommandeSecret> {
    if (!noms.length) return { ok: false, msg: "Usage : /secret attach <name>…" };
    await lireCompte();
    let relu = false;
    const trouves: Secret[] = [];
    for (const nom of noms) {
      let trouve = compte.value.find((x) => x.name === nom);
      if (!trouve && !relu) {
        relu = true;
        await lireCompte(true);
        trouve = compte.value.find((x) => x.name === nom);
      }
      if (!trouve) return { ok: false, msg: `Secret inconnu : ${nom}.` };
      trouves.push(trouve);
    }
    let ajoutes: string[] = [];
    const r = await muter((courants, chat) => {
      const liste = [...courants];
      ajoutes = [];
      for (const s of trouves) {
        const refus = chat ? null : refusLocal(s);
        if (refus) return { message: refus };
        if (liste.some((x) => x.id === s.id)) continue;
        liste.push(s);
        ajoutes.push(s.name);
      }
      return ajoutes.length ? liste : { message: `Déjà attaché : ${noms.join(", ")}.`, info: true };
    });
    return resultat(r, `Attaché : ${ajoutes.join(", ")}.`);
  }

  async function detacherNoms(noms: readonly string[]): Promise<ResultatCommandeSecret> {
    if (!noms.length) return { ok: false, msg: "Usage : /secret detach <name>|--all" };
    const tout = noms.includes("--all");
    let retires: string[] = [];
    const r = await muter((courants) => {
      if (!courants.length) return { message: "Aucun secret attaché.", info: true };
      const absent = tout ? undefined : noms.find((n) => !courants.some((s) => s.name === n));
      if (absent !== undefined) return { message: `Non attaché : ${absent}.` };
      retires = tout ? courants.map((s) => s.name) : [...noms];
      return tout ? [] : courants.filter((s) => !noms.includes(s.name));
    });
    return resultat(r, `Détaché : ${retires.join(", ")}.`);
  }

  async function lancer(raw: string): Promise<ResultatCommandeSecret> {
    const { verbe, noms } = analyserCommandeSecret(raw);
    if (verbe === "") return lister();
    if (verbe === "attach") return attacher(noms);
    if (verbe === "detach") return detacherNoms(noms);
    return { ok: false, msg: `Sous-commande inconnue : ${verbe}. attach, detach.` };
  }

  return {
    attaches,
    compte,
    disponibles,
    actualiser,
    recharger,
    appliquerDuChat,
    reinitialiser,
    vider,
    enAttente,
    envoyes,
    changementCompte,
    detacher,
    /** Commande `/secret` lue par le menu « / » du composeur. */
    commande: {
      disponible: (): boolean => true,
      valeurs,
      actualiser,
      lancer,
    },
  };
}

export type SecretsChat = ReturnType<typeof creerSecretsChat>;
