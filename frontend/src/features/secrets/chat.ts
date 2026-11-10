// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/chat.ts — secrets attachés à la conversation : puces `secret:<name>` (chat existant : `PUT /api/chats/:id/secrets` ; chat neuf : sélection gardée puis envoyée avec le premier tour) et commande `/secret` (liste, attach, detach, complétion des noms). */
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

export function creerSecretsChat(dep: DepsSecretsChat) {
  const maintenant = dep.maintenant ?? ((): number => Date.now());
  const attaches = ref<readonly Secret[]>([]);
  const compte = ref<readonly Secret[]>([]);
  let compteA = 0;
  let lecture: Promise<void> | null = null;
  /** Sélection faite sur un chat neuf, pas encore partie avec un tour. */
  let aSceller = false;
  let jeton = 0;

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

  /** Nouvel ensemble attaché ; message d'erreur (`detail` du serveur), ou `null` s'il est retenu. */
  async function definir(liste: readonly Secret[]): Promise<string | null> {
    if (liste.length > SECRETS_ATTACHES_MAX)
      return `${SECRETS_ATTACHES_MAX} secrets au plus par conversation.`;
    const chat = dep.currentChatId.value;
    if (!chat) {
      attaches.value = [...liste];
      aSceller = liste.length > 0;
      return null;
    }
    jeton++;
    const r = await dep.api.attacher(
      chat,
      liste.map((s) => s.id),
    );
    if (dep.currentChatId.value !== chat) return null;
    if (!r.ok) return r.message || "Secrets non enregistrés.";
    attaches.value = r.valeur;
    aSceller = false;
    return null;
  }

  async function recharger(chatId: string): Promise<void> {
    const j = ++jeton;
    const r = await dep.api.attaches(chatId);
    if (j !== jeton || dep.currentChatId.value !== chatId) return;
    if (r.ok) attaches.value = r.valeur;
  }

  /** Chat chargé : ses ids enregistrés (`secrets` de la conversation) ; métadonnées relues s'il y en a. */
  function appliquerDuChat(ids: unknown, chatId: string): void {
    jeton++;
    aSceller = false;
    attaches.value = [];
    if (chatId && idsValides(ids).length) void recharger(chatId);
  }

  function reinitialiser(): void {
    jeton++;
    aSceller = false;
    attaches.value = [];
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
    const err = await definir(attaches.value.filter((s) => s.id !== id));
    if (err) dep.toast(err, "error");
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
    await lireCompte(true);
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

  async function attacher(noms: readonly string[]): Promise<ResultatCommandeSecret> {
    if (!noms.length) return { ok: false, msg: "Usage : /secret attach <name>…" };
    await lireCompte();
    let relu = false;
    const liste = [...attaches.value];
    const ajoutes: string[] = [];
    for (const nom of noms) {
      let trouve = compte.value.find((x) => x.name === nom);
      if (!trouve && !relu) {
        relu = true;
        await lireCompte(true);
        trouve = compte.value.find((x) => x.name === nom);
      }
      const s = trouve;
      if (!s) return { ok: false, msg: `Secret inconnu : ${nom}.` };
      const refus = dep.currentChatId.value ? null : refusLocal(s);
      if (refus) return { ok: false, msg: refus };
      if (liste.some((x) => x.id === s.id)) continue;
      liste.push(s);
      ajoutes.push(s.name);
    }
    if (!ajoutes.length) return { ok: true, info: true, msg: `Déjà attaché : ${noms.join(", ")}.` };
    const err = await definir(liste);
    if (err) return { ok: false, msg: err };
    return { ok: true, msg: `Attaché : ${ajoutes.join(", ")}.` };
  }

  async function detacherNoms(noms: readonly string[]): Promise<ResultatCommandeSecret> {
    if (!noms.length) return { ok: false, msg: "Usage : /secret detach <name>|--all" };
    if (!attaches.value.length) return { ok: true, info: true, msg: "Aucun secret attaché." };
    const tout = noms.includes("--all");
    const absent = tout ? undefined : noms.find((n) => !attaches.value.some((s) => s.name === n));
    if (absent !== undefined) return { ok: false, msg: `Non attaché : ${absent}.` };
    const retires = tout ? attaches.value.map((s) => s.name) : [...noms];
    const err = await definir(tout ? [] : attaches.value.filter((s) => !noms.includes(s.name)));
    if (err) return { ok: false, msg: err };
    return { ok: true, msg: `Détaché : ${retires.join(", ")}.` };
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
    definir,
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
