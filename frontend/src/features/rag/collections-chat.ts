// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/collections-chat.ts — collections RAG actives d'un chat : sélection enregistrée par le serveur (chat existant) ou scellée à la création du chat, collections lisibles, pastilles du composeur ; API de la commande `/rag`. */
import {
  COLLECTIONS_CHAT_RAG_MAX,
  schemaErreurRouteRag,
  schemaReglageRagChat,
  schemaReponseCollectionsRag,
  schemaReponseRagChat,
} from "@elpis/contracts";
import type { CollectionVueRag } from "@elpis/contracts";
import { computed, ref } from "vue";
import type { ComputedRef, Ref } from "vue";

/** Pastille d'une collection active : seulement une collection que le compte lit encore. */
export interface CollectionActiveChat {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role: "proprietaire" | "lecteur";
  /** Nom de l'auteur pour une collection partagée, `null` pour une des miennes. */
  readonly auteur: string | null;
}

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface DepsCollectionsChat {
  readonly fetchAuth: FetchAuth;
  readonly showToast: (message: string, type?: string) => void;
  readonly currentChatId: Ref<string | null>;
}

/** API publique (pastilles, commande `/rag`, page RAG) ; chaque mutation rend vrai si la sélection est enregistrée. */
export interface ApiRagChat {
  /** Droit RAG du compte : `null` tant que la liste n'a pas été lue, faux après un refus (403). */
  readonly autorise: Ref<boolean | null>;
  /** Pastilles, dans l'ordre de la sélection. */
  readonly actives: ComputedRef<readonly CollectionActiveChat[]>;
  /** Collections lisibles par le compte : les miennes puis les partagées (masquées exclues). */
  readonly accessibles: Ref<readonly CollectionVueRag[]>;
  /** Identifiants sélectionnés (enregistrés, ou en attente d'un chat neuf). */
  readonly selection: Ref<readonly string[]>;
  rafraichir(): Promise<void>;
  activer(id: string): Promise<boolean>;
  retirer(id: string): Promise<boolean>;
  couper(): Promise<boolean>;
  definir(ids: readonly string[]): Promise<boolean>;
  /** Chat chargé : sa sélection (champ `rag` de `GET /api/saved/chats/:id`). */
  appliquerDuChat(rag: unknown): void;
  /** Relit la sélection enregistrée d'un chat (reprise d'onglet sans rechargement du chat). */
  recharger(chatId: string): Promise<void>;
  /** Chat neuf : sélection vidée, ou posée en attente (« Discuter avec »). */
  reinitialiser(ids?: readonly string[], noms?: Readonly<Record<string, string>>): void;
  /** Sélection à sceller par `POST /api/saved/chats/new` (vide si le chat existe déjà). */
  enAttente(): string[];
  /** Réponse de la création du chat : collections réellement actives. */
  confirmerCreation(ids: unknown): void;
  vider(): void;
}

const MESSAGES: Readonly<Record<string, string>> = {
  collection_introuvable: "Collection introuvable.",
  rag_interdit: "Le RAG n'est pas ouvert à votre compte.",
  chat_introuvable: "Conversation introuvable.",
};

async function codeErreur(rep: Response): Promise<string> {
  try {
    const r = schemaErreurRouteRag.safeParse(await rep.json());
    return r.success ? r.data.code : "";
  } catch {
    return "";
  }
}

export function creerCollectionsChat(dep: DepsCollectionsChat): ApiRagChat {
  const accessibles = ref<readonly CollectionVueRag[]>([]);
  const autorise = ref<boolean | null>(null);
  const selection = ref<readonly string[]>([]);
  const nomsProvisoires = ref<Readonly<Record<string, string>>>({});

  const actives = computed<readonly CollectionActiveChat[]>(() => {
    const parId = new Map(accessibles.value.map((c) => [c.id, c] as const));
    const sortie: CollectionActiveChat[] = [];
    for (const id of selection.value) {
      const c = parId.get(id);
      if (c)
        sortie.push({
          id,
          name: c.name,
          description: c.description,
          role: c.role,
          auteur: c.role === "lecteur" ? c.owner.display_name || c.owner.username : null,
        });
      else if (nomsProvisoires.value[id] !== undefined)
        sortie.push({
          id,
          name: nomsProvisoires.value[id] ?? "",
          description: "",
          role: "lecteur",
          auteur: null,
        });
    }
    return sortie;
  });

  async function rafraichir(): Promise<void> {
    let rep: Response | null;
    try {
      rep = await dep.fetchAuth("/api/rag/collections", {}, true);
    } catch {
      return;
    }
    if (!rep) return;
    if (rep.status === 403) {
      accessibles.value = [];
      autorise.value = false;
      return;
    }
    if (!rep.ok) return;
    try {
      const r = schemaReponseCollectionsRag.safeParse(await rep.json());
      if (r.success) {
        accessibles.value = r.data.collections;
        autorise.value = true;
      }
    } catch {
      /* réponse illisible : liste gardée */
    }
  }

  async function definir(ids: readonly string[]): Promise<boolean> {
    const voulus = [...new Set(ids)];
    if (voulus.length > COLLECTIONS_CHAT_RAG_MAX) {
      dep.showToast(`${COLLECTIONS_CHAT_RAG_MAX} collections au plus dans une conversation.`, "info");
      return false;
    }
    const chat = dep.currentChatId.value;
    if (!chat) {
      selection.value = voulus;
      return true;
    }
    let rep: Response | null;
    try {
      rep = await dep.fetchAuth(`/api/saved/chats/${encodeURIComponent(chat)}/rag`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collections: voulus }),
      });
    } catch {
      rep = null;
    }
    if (dep.currentChatId.value !== chat) return false;
    if (!rep) {
      dep.showToast("Collections non enregistrées : serveur injoignable.", "error");
      return false;
    }
    if (!rep.ok) {
      const code = await codeErreur(rep);
      dep.showToast(MESSAGES[code] ?? `Collections non enregistrées (erreur ${rep.status}).`, "error");
      if (code === "collection_introuvable") void rafraichir();
      return false;
    }
    try {
      const r = schemaReponseRagChat.safeParse(await rep.json());
      selection.value = r.success ? r.data.rag.collections : voulus;
    } catch {
      selection.value = voulus;
    }
    return true;
  }

  function appliquerDuChat(rag: unknown): void {
    const r = schemaReglageRagChat.safeParse(rag);
    selection.value = r.success ? r.data.collections : [];
    nomsProvisoires.value = {};
  }

  async function recharger(chatId: string): Promise<void> {
    let rep: Response | null;
    try {
      rep = await dep.fetchAuth(`/api/saved/chats/${encodeURIComponent(chatId)}`, {}, true);
    } catch {
      return;
    }
    if (!rep?.ok || dep.currentChatId.value !== chatId) return;
    try {
      const d: unknown = await rep.json();
      if (dep.currentChatId.value === chatId)
        appliquerDuChat(d !== null && typeof d === "object" ? (d as Record<string, unknown>)["rag"] : null);
    } catch {
      /* chat illisible : sélection gardée */
    }
  }

  function reinitialiser(ids: readonly string[] = [], noms: Readonly<Record<string, string>> = {}): void {
    selection.value = [...new Set(ids)].slice(0, COLLECTIONS_CHAT_RAG_MAX);
    nomsProvisoires.value = { ...noms };
  }

  return {
    autorise,
    actives,
    accessibles,
    selection,
    rafraichir,
    activer: (id) =>
      selection.value.includes(id) ? Promise.resolve(true) : definir([...selection.value, id]),
    retirer: (id) => definir(selection.value.filter((x) => x !== id)),
    couper: () => definir([]),
    definir,
    appliquerDuChat,
    recharger,
    reinitialiser,
    enAttente: () => (dep.currentChatId.value ? [] : [...selection.value]),
    confirmerCreation(ids: unknown): void {
      if (Array.isArray(ids)) selection.value = ids.filter((x): x is string => typeof x === "string");
      nomsProvisoires.value = {};
    },
    vider(): void {
      accessibles.value = [];
      autorise.value = null;
      reinitialiser();
    },
  };
}

export interface DepsEvenementsRag {
  /** Ouvre un chat neuf (vide la sélection). */
  readonly nouveauChat: () => Promise<void>;
  readonly apres?: () => void;
  readonly cible?: EventTarget;
}

/** « Discuter avec » (`rag:discuter`, `{id, name}`) : chat neuf, collection déjà active ; `rag:collections` : liste relue ; rend le désabonnement. */
export function ecouterEvenementsRag(api: ApiRagChat, dep: DepsEvenementsRag): () => void {
  const cible = dep.cible ?? window;
  const discuter = (ev: Event): void => {
    const d: unknown = (ev as CustomEvent<unknown>).detail;
    const o = d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};
    const id = o["id"];
    if (typeof id !== "string" || !id) return;
    const nom = typeof o["name"] === "string" ? o["name"] : "";
    void dep.nouveauChat().then(() => {
      api.reinitialiser([id], nom ? { [id]: nom } : {});
      void api.rafraichir();
      dep.apres?.();
    });
  };
  const relire = (): void => void api.rafraichir();
  cible.addEventListener("rag:discuter", discuter);
  cible.addEventListener("rag:collections", relire);
  return () => {
    cible.removeEventListener("rag:discuter", discuter);
    cible.removeEventListener("rag:collections", relire);
  };
}
