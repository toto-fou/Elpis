// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/rattachement.ts — console › Connexion d'entreprise : balayage de l'annuaire, assistant de rattachement des comptes existants, rattachements préparés (SSO) et détachement d'un compte. */
import {
  schemaCorpsConfirmationBalayage,
  schemaReponseMigration,
  schemaReponseRattachement,
  schemaReponseRattachementsPrepares,
  schemaReponseRechercheMigration,
} from "@elpis/contracts";
import type {
  CompteAMigrer,
  CompteConsole,
  EtatBalayageConsole,
  PropositionAnnuaire,
  RattachementPrepare,
} from "@elpis/contracts";
import type { Ref } from "vue";
import { z } from "zod";

import { gardeFocus as creerGardeFocus, piegerTab } from "../../utils/focus";
import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import { confirmerParMot } from "./confirmation";
import type { BaseAdmin } from "./etat";
import type { creerIdentite } from "./identite";

/** Réponse de rattachement dont la raison peut être inconnue d'un serveur plus récent. */
const schemaResultatsSouples = z.object({
  results: z.array(schemaReponseRattachement.shape.results.element.extend({ result: z.string() })),
});

const ENTETES_JSON = { "Content-Type": "application/json" };
const BASE = "/api/admin/auth/providers";
const TAILLE_PAGE_MIGRATION = 100;
const GARDE_CONFIRMATION_MS = 400;
const REFUSE = "Demande refusée par le serveur.";

const RAISONS_ABANDON: Readonly<Record<string, string>> = {
  group_missing: "Un groupe requis est introuvable dans l'annuaire : aucun compte n'a été modifié.",
  group_unreadable: "Les groupes de l'annuaire sont illisibles : aucun compte n'a été modifié.",
  secret_missing: "Le secret du compte de service est à ressaisir. Aucun compte n'a été modifié.",
  directory_unreachable: "Annuaire injoignable. Aucun compte n'a été modifié.",
  bind_failed: "Le compte de service est refusé par l'annuaire. Aucun compte n'a été modifié.",
  timeout: "L'annuaire n'a pas répondu à temps. Aucun compte n'a été modifié.",
  users_unreadable:
    "Le compte de service ne peut plus lire les entrées des utilisateurs : aucun compte n'a été modifié.",
  membership_unreadable:
    "Le compte de service ne peut plus lire l'appartenance aux groupes requis : aucun compte n'a été modifié.",
  stale: "La dernière vérification aboutie est trop ancienne : relancez-la. Aucun compte n'a été modifié.",
};
const ABANDON_GENERIQUE = "La vérification n'a pas pu aller au bout : aucun compte n'a été modifié.";

/** Phrase, sans jargon, d'une passe abandonnée : dit toujours que rien n'a été modifié. */
export function phraseAbandon(raison: string): string {
  return RAISONS_ABANDON[raison] ?? ABANDON_GENERIQUE;
}

const RAISONS_RETENUE: Readonly<Record<string, string>> = {
  entry_missing: "entrée introuvable",
  entry_disabled: "entrée désactivée",
  not_in_group: "hors des groupes requis",
};

/** Raison en clair d'une suspension retenue ; une raison inconnue reçoit une formule neutre. */
export const phraseRetenue = (raison: string): string => RAISONS_RETENUE[raison] ?? "à vérifier";

/** Phrase d'information sur les départs vus une seule fois. */
export const phraseObserves = (n: number): string =>
  n > 1
    ? `${n} comptes paraissent partis ; ils seront désactivés s'ils le sont encore à la prochaine vérification.`
    : "1 compte paraît parti ; il sera désactivé s'il l'est encore à la prochaine vérification.";

/** Plafond de comptes listés et confirmés en une fois (celui du serveur). */
const MAX_RETENUS = 200;

export interface RetenuesAffichees {
  comptes: EtatBalayageConsole["held"];
  autres: number;
  total: number;
  complet: boolean;
}

/** Comptes retenus montrés à l'administrateur (200 au plus) ; la confirmation n'est permise que si la liste est complète. */
export function retenuesAffichees(s: EtatBalayageConsole): RetenuesAffichees {
  const comptes = s.held.slice(0, MAX_RETENUS);
  const total = Math.max(s.pending, s.held_total, comptes.length);
  const autres = total - comptes.length;
  return { comptes, autres, total, complet: autres === 0 && comptes.length > 0 };
}

const PHRASES_LIEN: Readonly<Record<string, string>> = {
  linked: "Rattaché",
  account_not_found: "Compte introuvable.",
  account_has_identity: "Ce compte est déjà rattaché.",
  account_suspended: "Compte désactivé : réactivez-le d'abord.",
  admin_confirmation_required: "La confirmation de cet administrateur est requise.",
  last_local_admin: "Dernier administrateur à mot de passe local : gardez-le comme accès de secours.",
  entry_already_linked: "Cette entrée est déjà rattachée à un autre compte.",
  duplicate: "Cette entrée est choisie pour plusieurs comptes de la liste.",
  entry_not_found: "Entrée introuvable dans l'annuaire.",
  entry_ambiguous: "Plusieurs entrées correspondent : choisissez-en une.",
  entry_not_active: "Cette entrée de l'annuaire n'est pas active.",
  entry_not_loginable: "Cette entrée ne peut pas se connecter avec les réglages de cet annuaire.",
  not_in_group: "Cette entrée n'est dans aucun groupe requis.",
  groups_unknown: "Les groupes de cette entrée sont illisibles : réessayez.",
  directory_unavailable: "Annuaire injoignable, réessayez.",
};
const LIEN_GENERIQUE = "Rattachement impossible pour ce compte.";

/** Phrase du résultat d'un rattachement ; une raison inconnue reçoit une phrase générique. */
export function phraseLien(resultat: string): string {
  return PHRASES_LIEN[resultat] ?? LIEN_GENERIQUE;
}

const ETATS_ENTREE: Readonly<Record<string, string>> = {
  active: "Active",
  desactivee: "Désactivée",
  verrouillee: "Verrouillée",
  expiree: "Expirée",
  inconnu: "État inconnu",
};
export const etatEntree = (s: string): string => ETATS_ENTREE[s] ?? ETATS_ENTREE["inconnu"] ?? "";

/** Date relative d'un instant en secondes. */
export function dateRelative(ts: number, maintenant = Date.now()): string {
  const s = Math.max(0, Math.floor(maintenant / 1000 - ts));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

/** Une entrée n'est rattachable que si elle est active et dans un groupe requis (le serveur revérifie tout). */
export const entreeRattachable = (p: PropositionAnnuaire | null): boolean =>
  p !== null && p.state === "active" && p.in_required_group === true;

export interface RechercheLigne {
  ouvert: boolean;
  texte: string;
  resultats: PropositionAnnuaire[] | null;
  erreur: string;
  busy: boolean;
}

export interface LigneMigration {
  compte: CompteAMigrer;
  proposition: PropositionAnnuaire | null;
  coche: boolean;
  confirmeAdmin: boolean;
  recherche: RechercheLigne;
  resultat: string;
}

export interface EtatAssistant {
  providerId: string;
  label: string;
  lignes: LigneMigration[];
  total: number;
  offset: number;
  chargement: boolean;
  erreur: string;
  envoi: boolean;
  resume: string;
  arme: boolean;
  garderJetons: boolean;
}

export interface FormPrelink {
  user_id: number;
  expected: string;
  waiver: boolean;
  confirm_admin: boolean;
}

const formPrelinkVide = (): FormPrelink => ({
  user_id: 0,
  expected: "",
  waiver: false,
  confirm_admin: false,
});

const ligneDe = (c: CompteAMigrer, resultat = ""): LigneMigration => ({
  compte: c,
  proposition: c.proposal,
  coche: false,
  confirmeAdmin: false,
  recherche: { ouvert: false, texte: "", resultats: null, erreur: "", busy: false },
  resultat,
});

export function creerRattachement(b: BaseAdmin, identite: ReturnType<typeof creerIdentite>) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref, watch } = vue;
  const { fetchAuth, showToast } = ctx;
  const { authEtat, authTiroir, loadEnterpriseAuth } = identite;

  /** Appel de l'API : statut (0 sans réponse) et corps JSON. */
  async function envoyer(
    methode: string,
    chemin: string,
    corps?: unknown,
  ): Promise<{ statut: number; res: Response | null; donnees: unknown }> {
    try {
      const res = await fetchAuth(chemin, {
        method: methode,
        headers: corps === undefined ? undefined : ENTETES_JSON,
        body: corps === undefined ? undefined : JSON.stringify(corps),
      });
      if (!res) return { statut: 0, res: null, donnees: null };
      return { statut: res.status, res, donnees: res.ok ? null : await corpsJson(res) };
    } catch {
      return { statut: 0, res: null, donnees: null };
    }
  }
  const erreurServeur = (statut: number, donnees: unknown): string =>
    statut === 0 ? "Erreur réseau." : detailErreur(donnees, REFUSE);

  // ── Balayage de l'annuaire ───────────────────────────────────────────────
  const balayageEnCours: Ref<string | null> = ref(null);
  const balayageMessage: Ref<Record<string, string>> = ref({});
  const poser = (id: string, m: string): void => {
    balayageMessage.value = { ...balayageMessage.value, [id]: m };
  };

  async function balayageLancer(id: string): Promise<void> {
    if (balayageEnCours.value !== null) return;
    balayageEnCours.value = id;
    poser(id, "");
    try {
      const { statut, donnees } = await envoyer("POST", `${BASE}/${encodeURIComponent(id)}/sweep`);
      if (statut === 409) poser(id, "Une vérification est déjà en cours.");
      else if (statut < 200 || statut >= 300) poser(id, erreurServeur(statut, donnees));
      await loadEnterpriseAuth();
    } finally {
      balayageEnCours.value = null;
    }
  }

  async function balayageConfirmer(id: string, etatPasse: EtatBalayageConsole): Promise<void> {
    const r = retenuesAffichees(etatPasse);
    if (balayageEnCours.value !== null || !r.complet) return;
    const corps = schemaCorpsConfirmationBalayage.safeParse({
      user_ids: [...new Set(r.comptes.map((c) => c.user_id))],
      // Empreinte de l'ensemble retenu tel qu'il a été affiché : le serveur refuse s'il a changé depuis.
      held_hash: etatPasse.held_hash,
    });
    if (!corps.success) return;
    const n = corps.data.user_ids.length;
    const ok = await confirmerParMot(
      ctx,
      "Désactiver ces comptes",
      `${n} compte${n > 1 ? "s" : ""} ne ${n > 1 ? "sont" : "est"} plus dans l'annuaire ou dans un groupe requis. Ils seront désactivés et leurs sessions fermées. Tapez ${n} pour confirmer.`,
      String(n),
      n > 1 ? `Désactiver ces ${n} comptes` : "Désactiver ce compte",
    );
    if (!ok) return;
    balayageEnCours.value = id;
    poser(id, "");
    try {
      const { statut, donnees } = await envoyer(
        "POST",
        `${BASE}/${encodeURIComponent(id)}/sweep/confirm`,
        corps.data,
      );
      if (statut === 409) poser(id, "La situation a changé, vérifiez à nouveau.");
      else if (statut < 200 || statut >= 300) poser(id, erreurServeur(statut, donnees));
      else showToast("Comptes désactivés", "success");
      await loadEnterpriseAuth();
    } finally {
      balayageEnCours.value = null;
    }
  }

  // ── Assistant de rattachement des comptes existants ──────────────────────
  const assistant: Ref<EtatAssistant | null> = ref(null);
  const assistantDrawer: Ref<HTMLElement | null> = ref(null);
  const gardeAssistant = creerGardeFocus();
  let sequenceAssistant = 0;
  let armeLe = 0;

  const selection = computed<LigneMigration[]>(() =>
    (assistant.value?.lignes ?? []).filter(
      (l) =>
        l.coche &&
        entreeRattachable(l.proposition) &&
        (l.compte.role === "user" || l.confirmeAdmin) &&
        !assistant.value?.envoi,
    ),
  );

  function erreurAnnuaire(statut: number, donnees: unknown): string {
    if (statut === 503) return "Annuaire injoignable, réessayez.";
    if (statut === 409) return "Cet annuaire n'est pas activé.";
    return erreurServeur(statut, donnees);
  }

  async function assistantCharger(offset: number, reprises: Map<number, string> = new Map()): Promise<void> {
    const a = assistant.value;
    if (!a) return;
    const moi = ++sequenceAssistant;
    a.chargement = true;
    a.erreur = "";
    const { statut, res, donnees } = await envoyer(
      "GET",
      `${BASE}/${encodeURIComponent(a.providerId)}/migration?offset=${offset}&limit=${TAILLE_PAGE_MIGRATION}`,
    );
    if (moi !== sequenceAssistant || assistant.value !== a) return;
    a.chargement = false;
    const lu = res?.ok ? await lireSchema(res, schemaReponseMigration) : null;
    if (!lu) {
      a.erreur = res?.ok ? "Réponse du serveur inattendue." : erreurAnnuaire(statut, donnees);
      return;
    }
    a.lignes = lu.items.map((c) => ligneDe(c, reprises.get(c.user_id) ?? ""));
    a.total = lu.total;
    a.offset = lu.offset;
    a.arme = false;
  }

  function assistantOuvrir(id: string): void {
    const p = authEtat.value?.providers.find((x) => x.id === id);
    if (!p || p.type !== "ldap") return;
    if (!assistant.value) gardeAssistant.remember();
    assistant.value = {
      providerId: id,
      label: p.label,
      lignes: [],
      total: 0,
      offset: 0,
      chargement: true,
      erreur: "",
      envoi: false,
      resume: "",
      arme: false,
      garderJetons: false,
    };
    void assistantCharger(0);
    void ctx.nextTick().then(() => assistantDrawer.value?.focus());
  }
  function assistantFermer(): void {
    sequenceAssistant += 1;
    const ouvert = assistant.value !== null;
    assistant.value = null;
    if (ouvert) gardeAssistant.restore();
  }
  function assistantTouche(ev: KeyboardEvent): void {
    piegerTab(ev, assistantDrawer.value);
  }
  function assistantPage(delta: number): void {
    const a = assistant.value;
    if (!a || a.chargement || a.envoi) return;
    void assistantCharger(Math.max(0, a.offset + delta * TAILLE_PAGE_MIGRATION));
  }

  /** Une case par ligne, jamais pour plusieurs lignes à la fois : cocher une ligne ne touche aucune autre. */
  function assistantCocher(l: LigneMigration): void {
    if (!entreeRattachable(l.proposition) || assistant.value?.envoi) return;
    l.coche = !l.coche;
    if (!l.coche) l.confirmeAdmin = false;
    l.resultat = "";
  }

  function assistantChercherOuvrir(l: LigneMigration): void {
    l.recherche.ouvert = !l.recherche.ouvert;
  }
  async function assistantRechercher(l: LigneMigration): Promise<void> {
    const a = assistant.value;
    const r = l.recherche;
    if (!a || r.busy) return;
    const q = r.texte.trim();
    if (q.length < 3) {
      r.erreur = "Saisissez 3 caractères au moins.";
      return;
    }
    r.busy = true;
    r.erreur = "";
    const { statut, res, donnees } = await envoyer(
      "POST",
      `${BASE}/${encodeURIComponent(a.providerId)}/migration/search`,
      { query: q },
    );
    r.busy = false;
    const lu = res?.ok ? await lireSchema(res, schemaReponseRechercheMigration) : null;
    if (!lu) {
      r.erreur = res?.ok ? "Réponse du serveur inattendue." : erreurAnnuaire(statut, donnees);
      return;
    }
    r.resultats = lu.items;
  }
  function assistantChoisir(l: LigneMigration, p: PropositionAnnuaire): void {
    l.proposition = p;
    l.coche = false;
    l.confirmeAdmin = false;
    l.resultat = "";
    l.recherche = { ouvert: false, texte: "", resultats: null, erreur: "", busy: false };
  }

  watch(
    () => selection.value.map((l) => l.compte.user_id).join(","),
    () => {
      if (assistant.value) assistant.value.arme = false;
    },
  );

  /** Premier clic : arme le bouton (même bouton, même place) ; second clic après la garde : envoie. */
  async function assistantLier(): Promise<void> {
    const a = assistant.value;
    const choix = selection.value;
    if (!a || a.envoi || choix.length === 0) return;
    if (!a.arme) {
      a.arme = true;
      armeLe = Date.now();
      return;
    }
    if (Date.now() - armeLe < GARDE_CONFIRMATION_MS) return;
    const admins = choix.filter((l) => l.compte.role !== "user").map((l) => l.compte.user_id);
    a.envoi = true;
    a.erreur = "";
    a.resume = "";
    const { statut, res, donnees } = await envoyer(
      "POST",
      `${BASE}/${encodeURIComponent(a.providerId)}/migration/link`,
      {
        links: choix.map((l) => ({ user_id: l.compte.user_id, subject: l.proposition?.subject ?? "" })),
        confirm_admins: admins,
        keep_tokens: a.garderJetons,
      },
    );
    a.envoi = false;
    a.arme = false;
    if (assistant.value !== a) return;
    const lu = res?.ok ? await lireSchema(res, schemaResultatsSouples) : null;
    if (!lu) {
      a.erreur = res?.ok ? "Réponse du serveur inattendue." : erreurAnnuaire(statut, donnees);
      return;
    }
    const phrases = new Map<number, string>();
    let rattaches = 0;
    let jetons = 0;
    let acces = 0;
    for (const r of lu.results) {
      if (r.result === "linked") {
        rattaches += 1;
        jetons += r.revoked_tokens ?? 0;
        acces += r.revoked_oauth ?? 0;
      } else phrases.set(r.user_id, phraseLien(r.result));
    }
    for (const l of a.lignes) {
      l.coche = false;
      l.confirmeAdmin = false;
    }
    a.resume =
      rattaches > 0
        ? `${rattaches} compte${rattaches > 1 ? "s" : ""} rattaché${rattaches > 1 ? "s" : ""}.`
        : "Aucun compte n'a été rattaché.";
    if (jetons > 0 || acces > 0)
      a.resume += ` Révoqués : ${jetons} jeton${jetons > 1 ? "s" : ""} d'API, ${acces} accès d'application.`;
    if (rattaches > 0) {
      void lien.loadUsers();
      void loadEnterpriseAuth();
    }
    await assistantCharger(a.offset, phrases);
    for (const l of a.lignes) l.resultat = phrases.get(l.compte.user_id) ?? l.resultat;
  }

  watch(e.adminTab, (page) => {
    if (page !== "enterprise-login") assistant.value = null;
  });

  // ── Rattachements préparés (fournisseur SSO) ─────────────────────────────
  const prelinks: Ref<RattachementPrepare[]> = ref([]);
  const prelinksErreur = ref("");
  const prelinksBusy = ref(false);
  const prelinkForm: Ref<FormPrelink> = ref(formPrelinkVide());
  let sequencePrelinks = 0;

  const prelinkComptes = computed<CompteConsole[]>(() => e.usersList.value.filter((u) => !u.identity));
  const prelinkCompte = computed(
    () => e.usersList.value.find((u) => u.id === prelinkForm.value.user_id) ?? null,
  );
  const prelinkAdmin = computed(() => [1, 2].includes(Number(prelinkCompte.value?.is_admin)));

  const idPrelinks = computed<string | null>(() => {
    const f = authTiroir.value;
    return f && !f.nouveau && f.type === "oidc" ? f.id : null;
  });

  async function prelinksCharger(): Promise<void> {
    const id = idPrelinks.value;
    if (id === null) return;
    const moi = ++sequencePrelinks;
    const { statut, res, donnees } = await envoyer("GET", `${BASE}/${encodeURIComponent(id)}/prelinks`);
    if (moi !== sequencePrelinks) return;
    const lu = res?.ok ? await lireSchema(res, schemaReponseRattachementsPrepares) : null;
    if (lu) {
      prelinks.value = lu.items;
      prelinksErreur.value = "";
    } else prelinksErreur.value = res?.ok ? "Réponse du serveur inattendue." : erreurServeur(statut, donnees);
  }

  watch(idPrelinks, (id) => {
    sequencePrelinks += 1;
    prelinks.value = [];
    prelinksErreur.value = "";
    prelinkForm.value = formPrelinkVide();
    if (id === null) return;
    if (e.usersList.value.length === 0) void lien.loadUsers();
    void prelinksCharger();
  });

  /** Un administrateur ou un modérateur ne reçoit jamais la dispense : la case est décochée avec lui. */
  watch(
    () => prelinkForm.value.user_id,
    () => {
      prelinkForm.value.confirm_admin = false;
      if (prelinkAdmin.value) prelinkForm.value.waiver = false;
    },
  );

  const prelinkPret = computed(() => {
    const f = prelinkForm.value;
    return f.user_id > 0 && f.expected.trim() !== "" && (!prelinkAdmin.value || f.confirm_admin);
  });

  async function prelinkAjouter(): Promise<void> {
    const id = idPrelinks.value;
    const f = prelinkForm.value;
    if (id === null || prelinksBusy.value || !prelinkPret.value) return;
    prelinksBusy.value = true;
    prelinksErreur.value = "";
    try {
      const { statut, donnees } = await envoyer("POST", `${BASE}/${encodeURIComponent(id)}/prelinks`, {
        user_id: f.user_id,
        expected: f.expected.trim(),
        waiver: prelinkAdmin.value ? false : f.waiver,
        confirm_admin: prelinkAdmin.value && f.confirm_admin,
      });
      if (statut < 200 || statut >= 300) {
        prelinksErreur.value = erreurServeur(statut, donnees);
        return;
      }
      prelinkForm.value = formPrelinkVide();
      showToast("Rattachement préparé", "success");
      await prelinksCharger();
    } finally {
      prelinksBusy.value = false;
    }
  }

  async function prelinkSupprimer(p: RattachementPrepare): Promise<void> {
    const id = idPrelinks.value;
    if (id === null || prelinksBusy.value) return;
    const ok = await ctx.openConfirm(
      "Supprimer ce rattachement préparé",
      `Le rattachement préparé de « ${p.username ?? "compte supprimé"} » sera supprimé.`,
      true,
      "Supprimer",
    );
    if (!ok) return;
    prelinksBusy.value = true;
    prelinksErreur.value = "";
    try {
      const { statut, donnees } = await envoyer(
        "DELETE",
        `${BASE}/${encodeURIComponent(id)}/prelinks/${p.id}`,
      );
      if (statut < 200 || statut >= 300) prelinksErreur.value = erreurServeur(statut, donnees);
      else await prelinksCharger();
    } finally {
      prelinksBusy.value = false;
    }
  }

  // ── Détachement d'un compte ──────────────────────────────────────────────
  const detachCible: Ref<CompteConsole | null> = ref(null);
  const detachMotDePasse = ref("");
  const detachErreur = ref("");
  const detachBusy = ref(false);

  function detachOuvrir(u: CompteConsole): void {
    if (!u.identity || u.id === b.refs.user.value?.id) return;
    detachCible.value = u;
    detachMotDePasse.value = "";
    detachErreur.value = "";
  }
  function detachFermer(): void {
    detachCible.value = null;
    detachMotDePasse.value = "";
    detachErreur.value = "";
  }
  async function detachConfirmer(): Promise<void> {
    const u = detachCible.value;
    if (!u || detachBusy.value || detachMotDePasse.value === "") return;
    detachBusy.value = true;
    detachErreur.value = "";
    try {
      const { statut, donnees } = await envoyer("POST", `/api/admin/users/${u.id}/identity/detach`, {
        new_password: detachMotDePasse.value,
      });
      if (statut < 200 || statut >= 300) {
        detachErreur.value = erreurServeur(statut, donnees);
        return;
      }
      detachFermer();
      showToast(`${u.username} : compte redevenu local`, "success");
      await lien.loadUsers();
    } finally {
      detachBusy.value = false;
    }
  }

  return {
    balayageEnCours,
    balayageMessage,
    balayageLancer,
    balayageConfirmer,
    assistant,
    assistantDrawer,
    assistantSelection: selection,
    assistantOuvrir,
    assistantFermer,
    assistantTouche,
    assistantPage,
    assistantCocher,
    assistantChercherOuvrir,
    assistantRechercher,
    assistantChoisir,
    assistantLier,
    prelinks,
    prelinksErreur,
    prelinksBusy,
    prelinkForm,
    prelinkComptes,
    prelinkAdmin,
    prelinkPret,
    prelinkAjouter,
    prelinkSupprimer,
    detachCible,
    detachMotDePasse,
    detachErreur,
    detachBusy,
    detachOuvrir,
    detachFermer,
    detachConfirmer,
  };
}
