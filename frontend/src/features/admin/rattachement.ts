// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/rattachement.ts — console › SSO OpenID Connect : rattachements préparés (carte « Comptes existants », fournisseur choisi) et détachement d'un compte. */
import { schemaReponseRattachementsPrepares } from "@elpis/contracts";
import type { CompteConsole, RattachementPrepare } from "@elpis/contracts";
import type { Ref } from "vue";

import { lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { envoyerJson, erreurServeur } from "./identite";
import type { creerIdentite } from "./identite";

const BASE = "/api/admin/auth/providers";

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

export function creerRattachement(b: BaseAdmin, identite: ReturnType<typeof creerIdentite>) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref, watch } = vue;
  const { fetchAuth, showToast } = ctx;
  const { authEtat } = identite;

  // ── Rattachements préparés (fournisseur SSO) ─────────────────────────────
  const prelinks: Ref<RattachementPrepare[]> = ref([]);
  const prelinksErreur = ref("");
  const prelinksBusy = ref(false);
  const prelinkForm: Ref<FormPrelink> = ref(formPrelinkVide());
  const prelinkChoix = ref("");
  let sequencePrelinks = 0;

  const prelinkComptes = computed<CompteConsole[]>(() => e.usersList.value.filter((u) => !u.identity));
  const prelinkCompte = computed(
    () => e.usersList.value.find((u) => u.id === prelinkForm.value.user_id) ?? null,
  );
  const prelinkAdmin = computed(() => [1, 2].includes(Number(prelinkCompte.value?.is_admin)));

  const fournisseurs = computed(() => authEtat.value?.providers ?? []);
  /** Fournisseur de la carte sur la page SSO : le choix, ou le seul enregistré ; `null` sinon. */
  const idPrelinks = computed<string | null>(() => {
    if (e.adminTab.value !== "oidc") return null;
    const liste = fournisseurs.value;
    if (liste.some((p) => p.id === prelinkChoix.value)) return prelinkChoix.value;
    return liste.length === 1 ? (liste[0]?.id ?? null) : null;
  });
  const prelinkFournisseur = computed({
    get: (): string => idPrelinks.value ?? "",
    set: (v: string) => {
      prelinkChoix.value = v;
    },
  });
  /** Raison pour laquelle la carte est grisée (texte vide : disponible). */
  const prelinkRaison = computed(() => {
    if (fournisseurs.value.length === 0)
      return "Enregistrez d'abord un fournisseur (carte « 2. Fournisseurs »).";
    return idPrelinks.value === null ? "Choisissez d'abord le fournisseur." : "";
  });

  async function prelinksCharger(): Promise<void> {
    const id = idPrelinks.value;
    if (id === null) return;
    const moi = ++sequencePrelinks;
    const { statut, res, donnees } = await envoyerJson(
      fetchAuth,
      "GET",
      `${BASE}/${encodeURIComponent(id)}/prelinks`,
    );
    if (moi !== sequencePrelinks) return;
    const lu = res?.ok ? await lireSchema(res, schemaReponseRattachementsPrepares) : null;
    if (lu) {
      prelinks.value = lu.items;
      prelinksErreur.value = "";
    } else prelinksErreur.value = res?.ok ? "Réponse du serveur inattendue." : erreurServeur(statut, donnees);
  }

  // Autre fournisseur : liste et formulaire repartent de zéro ; état relu (enregistrement, activation) : liste relue.
  watch([idPrelinks, authEtat], ([id], [avant]) => {
    if (id !== avant) {
      sequencePrelinks += 1;
      prelinks.value = [];
      prelinksErreur.value = "";
      prelinkForm.value = formPrelinkVide();
      if (id !== null && e.usersList.value.length === 0) void lien.loadUsers();
    }
    if (id !== null) void prelinksCharger();
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
    return (
      idPrelinks.value !== null &&
      f.user_id > 0 &&
      f.expected.trim() !== "" &&
      (!prelinkAdmin.value || f.confirm_admin)
    );
  });

  async function prelinkAjouter(): Promise<void> {
    const id = idPrelinks.value;
    const f = prelinkForm.value;
    if (id === null || prelinksBusy.value || !prelinkPret.value) return;
    prelinksBusy.value = true;
    prelinksErreur.value = "";
    try {
      const { statut, donnees } = await envoyerJson(
        fetchAuth,
        "POST",
        `${BASE}/${encodeURIComponent(id)}/prelinks`,
        {
          user_id: f.user_id,
          expected: f.expected.trim(),
          waiver: prelinkAdmin.value ? false : f.waiver,
          confirm_admin: prelinkAdmin.value && f.confirm_admin,
        },
      );
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
      const { statut, donnees } = await envoyerJson(
        fetchAuth,
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
      const { statut, donnees } = await envoyerJson(
        fetchAuth,
        "POST",
        `/api/admin/users/${u.id}/identity/detach`,
        {
          new_password: detachMotDePasse.value,
        },
      );
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
    prelinks,
    prelinksErreur,
    prelinksBusy,
    prelinkForm,
    prelinkFournisseur,
    prelinkRaison,
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
