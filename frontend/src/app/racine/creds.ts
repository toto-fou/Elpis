// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/creds.ts — fenêtre de la commande /creds : jeton ⟦creds:…⟧ d'une conversation depuis une entrée du coffre ou un identifiant ponctuel ; le mot de passe ne passe ni par le prompt ni par le brouillon. */
import type { EntreeCoffre, JetonCreds } from "@elpis/contracts";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { Ref, ShallowUnwrapRef } from "vue";

import { creerApiCoffre } from "../../features/coffre/api";
import { EVT_OUVRIR_CREDS } from "../../features/coffre/ouverture";
import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";

export type ModeCreds = "coffre" | "ponctuel";

export interface DependancesCreds {
  readonly http: ClientHttp;
  readonly currentChatId: Ref<string | null>;
  readonly inputMessage: Ref<string>;
  readonly inputRef: Ref<HTMLTextAreaElement | null>;
  /** Crée la conversation côté serveur si elle n'existe pas encore ; son identifiant, ou `false`. */
  ensureChat(): Promise<string | false>;
  showToast(message: string, type?: string): void;
}

/** `⟦creds:JETON@ORIGINE⟧` glissé dans le brouillon, séparé du texte qui précède (l'origine rappelle où le jeton vaut). */
export function brouillonAvecJeton(brouillon: string, jeton: string, origine: string): string {
  const marque = `⟦creds:${jeton}@${origine}⟧`;
  return brouillon && !/\s$/u.test(brouillon) ? `${brouillon} ${marque}` : `${brouillon}${marque}`;
}

/** « 12 min » ou « 45 s » avant l'échéance, « expiré » ensuite. */
export function delaiRestant(expiresAt: number, maintenant: number): string {
  const s = Math.floor(expiresAt - maintenant);
  if (s <= 0) return "expiré";
  return s >= 90 ? `${Math.ceil(s / 60)} min` : `${s} s`;
}

export function creerCreds(dep: DependancesCreds) {
  const api = creerApiCoffre(dep.http);
  const showCredsModal = ref(false);
  const credsEntries = ref<EntreeCoffre[]>([]);
  const credsTokens = ref<JetonCreds[]>([]);
  const credsMode = ref<ModeCreds>("coffre");
  const credsEntree = ref<number | null>(null);
  const credsOrigine = ref("");
  const credsIdentifiant = ref("");
  const credsMotDePasse = ref("");
  const credsEnregistrer = ref(false);
  const credsCertificat = ref(false);
  const credsBusy = ref(false);
  const credsErreur = ref("");
  const credsMaintenant = ref(Date.now() / 1000);
  const credsUtilisables = computed(() => credsEntries.value.filter((e) => e.origin_confirmed && e.origin));
  let minuteur: ReturnType<typeof setInterval> | null = null;

  function arreterMinuteur(): void {
    if (minuteur !== null) clearInterval(minuteur);
    minuteur = null;
  }
  onScopeDispose(arreterMinuteur);

  function vider(): void {
    credsMotDePasse.value = "";
    credsIdentifiant.value = "";
    credsOrigine.value = "";
    credsEnregistrer.value = false;
    credsCertificat.value = false;
    credsErreur.value = "";
    credsEntree.value = null;
  }

  async function chargerJetons(): Promise<void> {
    const id = dep.currentChatId.value;
    if (!id) {
      credsTokens.value = [];
      return;
    }
    const r = await api.jetons(id);
    if (r.type === "ok") credsTokens.value = r.valeur.items;
  }

  async function ouvrirCreds(): Promise<void> {
    vider();
    credsMaintenant.value = Date.now() / 1000;
    showCredsModal.value = true;
    const r = await api.lister();
    if (r.type === "ok") credsEntries.value = r.valeur.items;
    credsMode.value = credsUtilisables.value.length ? "coffre" : "ponctuel";
    credsEntree.value = credsUtilisables.value[0]?.id ?? null;
    await chargerJetons();
  }

  function fermerCreds(): void {
    showCredsModal.value = false;
    vider();
  }

  watch(showCredsModal, (ouvert) => {
    // Toute fermeture (Échap, clic à côté, déconnexion) vide aussi les champs, mot de passe compris.
    if (!ouvert) vider();
    arreterMinuteur();
    if (ouvert) minuteur = setInterval(() => (credsMaintenant.value = Date.now() / 1000), 15_000);
  });

  function inserer(jeton: string, origine: string): void {
    dep.inputMessage.value = brouillonAvecJeton(dep.inputMessage.value, jeton, origine);
    const zone = dep.inputRef.value;
    if (zone) {
      zone.focus();
      zone.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function validerCreds(): Promise<void> {
    if (credsBusy.value) return;
    const ponctuel = credsMode.value === "ponctuel";
    const origine = credsOrigine.value.trim();
    const identifiant = credsIdentifiant.value.trim();
    if (ponctuel ? !origine || !identifiant || !credsMotDePasse.value : credsEntree.value === null) {
      credsErreur.value = ponctuel
        ? "Origine, identifiant et mot de passe requis."
        : "Choisissez une entrée du coffre.";
      return;
    }
    credsBusy.value = true;
    credsErreur.value = "";
    // Le mot de passe quitte l'état de la fenêtre dès l'envoi ; il n'est jamais écrit dans le brouillon.
    const motDePasse = credsMotDePasse.value;
    credsMotDePasse.value = "";
    try {
      const chat = dep.currentChatId.value || (await dep.ensureChat());
      if (!chat) {
        credsErreur.value = "Conversation indisponible.";
        return;
      }
      const r = await api.creerJeton(
        ponctuel
          ? {
              chat_id: chat,
              origin: origine,
              username: identifiant,
              password: motDePasse,
              save: credsEnregistrer.value,
              allow_insecure_tls: credsCertificat.value,
            }
          : { chat_id: chat, entry_id: credsEntree.value as number },
      );
      if (r.type !== "ok") {
        credsErreur.value = messageErreur(r) || "Échec de la création";
        return;
      }
      inserer(r.valeur.token, r.valeur.item.origin);
      dep.showToast("Identifiant ajouté au message (30 min)", "success");
      fermerCreds();
    } finally {
      credsBusy.value = false;
    }
  }

  async function renouvelerCreds(j: JetonCreds): Promise<void> {
    const r = await api.renouveler(j.id);
    if (r.type === "ok") await chargerJetons();
    else dep.showToast(messageErreur(r) || "Échec du renouvellement", "error");
  }

  async function revoquerCreds(j: JetonCreds): Promise<void> {
    const r = await api.revoquer(j.id);
    if (r.type === "ok") await chargerJetons();
    else dep.showToast(messageErreur(r) || "Échec de la révocation", "error");
  }

  function credsExpire(j: JetonCreds): string {
    return delaiRestant(j.expires_at, credsMaintenant.value);
  }

  const surOuvrir = (): void => void ouvrirCreds();
  window.addEventListener(EVT_OUVRIR_CREDS, surOuvrir);
  onScopeDispose(() => window.removeEventListener(EVT_OUVRIR_CREDS, surOuvrir));

  return {
    showCredsModal,
    credsEntries,
    credsUtilisables,
    credsTokens,
    credsMode,
    credsEntree,
    credsOrigine,
    credsIdentifiant,
    credsMotDePasse,
    credsEnregistrer,
    credsCertificat,
    credsBusy,
    credsErreur,
    ouvrirCreds,
    fermerCreds,
    validerCreds,
    renouvelerCreds,
    revoquerCreds,
    credsExpire,
  };
}

export type Creds = ReturnType<typeof creerCreds>;
/** Vue des gabarits : refs déballées. */
export type SurfaceCreds = ShallowUnwrapRef<Creds>;
