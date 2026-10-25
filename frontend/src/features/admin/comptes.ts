// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/comptes.ts — console › Utilisateurs & accès : table des comptes (tri, filtre, pages), éditeur de compte en ligne, groupes, accès aux serveurs d'inférence, réinitialisation de mot de passe. */
import { suivreChargement } from "./suivi-chargement";
import {
  schemaReponseAccesCompte,
  schemaReponseComptesConsole,
  schemaReponseGroupesConsole,
  schemaReponseMachinesCompte,
} from "@elpis/contracts";
import type { CompteConsole, schemaMoteurChoisissable } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, listeObjets, lireSchema, objet } from "../../utils/lecture-json";
import { confirmerParMot } from "./confirmation";
import type { BaseAdmin, GroupeAffiche } from "./etat";
import { lireChemin } from "./etat";
import type { z } from "zod";

type MoteurChoisissable = z.infer<typeof schemaMoteurChoisissable> & { base_url?: string };
type AccesCompte = z.infer<typeof schemaReponseAccesCompte>;

const ENTETES_JSON = { "Content-Type": "application/json" };
const TAILLE_PAGE = 25;

export type ModeMoteurs = "inherit" | "all" | "list";
export type ModeGestion = "inherit" | "allow" | "deny";

export interface FormulaireAcces {
  engineMode: ModeMoteurs;
  engineKeys: string[];
  manage: ModeGestion;
  _origKeys: string | null;
  _origManage: boolean | null;
}

export interface EditionCompte extends FormulaireAcces {
  id: number;
  user: CompteConsole;
  saving: boolean;
  role: string;
  groups: number[];
  quota: number | string;
  network: string;
  desktop: string[];
  _orig: string;
  access?: AccesCompte;
}

export interface ModaleGroupe extends FormulaireAcces {
  show: boolean;
  isEdit: boolean;
  id: number | null;
  name: string;
  description: string;
}

export interface TriUtilisateurs {
  field: string;
  dir: 1 | -1;
}

const SOURCES_ACCES: Readonly<Record<string, string>> = {
  admin: "Administrateur : accès complet",
  user: "Réglé sur le compte",
  groups: "Hérité des groupes",
  default: "Aucune restriction",
};

function formulaireAcces(
  cles: readonly string[] | null | undefined,
  gestion: boolean | null | undefined,
): FormulaireAcces {
  const k = Array.isArray(cles) ? cles : null;
  return {
    engineMode: k === null ? "inherit" : k.includes("*") ? "all" : "list",
    engineKeys: k ? k.filter((x) => x !== "*") : [],
    manage: gestion === true ? "allow" : gestion === false ? "deny" : "inherit",
    _origKeys: k ? JSON.stringify(k) : null,
    _origManage: gestion === true || gestion === false ? gestion : null,
  };
}

function chargeAcces(m: FormulaireAcces): {
  body: { engine_keys: string[] | null; can_manage_models: boolean | null };
  changed: boolean;
} {
  const keys =
    m.engineMode === "inherit"
      ? null
      : m.engineMode === "all"
        ? ["*"]
        : m.engineKeys.filter((x) => x !== "*");
  const manage = m.manage === "allow" ? true : m.manage === "deny" ? false : null;
  const changed = (keys === null ? null : JSON.stringify(keys)) !== m._origKeys || manage !== m._origManage;
  return { body: { engine_keys: keys, can_manage_models: manage }, changed };
}

const roleDe = (u: CompteConsole): string =>
  u.is_admin === 1 ? "admin" : u.is_admin === 2 ? "moderator" : "user";

export function creerComptes(b: BaseAdmin) {
  const { vue, ctx, e, lien, refs } = b;
  const { computed, ref, watch } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const { usersList, usersNetProfiles, usersDesktopTargets, groupsList } = e;

  // ── Table des comptes ────────────────────────────────────────────────────
  const usersSearch = ref("");
  const usersSort: Ref<TriUtilisateurs> = ref({ field: "id", dir: 1 });
  const usersPage = ref(1);
  const usersFilters: Ref<string[]> = ref([]);
  const FILTRES_COMPTES: Readonly<Record<string, (u: CompteConsole) => boolean>> = {
    admin: (u) => u.is_admin === 1,
    "sans-groupe": (u) => !u.group_names,
  };
  /** Valeur de tri d'une colonne : texte ou nombre, comparés champ par champ. */
  function valeurTri(u: CompteConsole, champ: string): string | number {
    switch (champ) {
      case "role":
        return u.is_admin === 1 ? 0 : u.is_admin === 2 ? 1 : 2;
      case "servers":
        return u.is_admin === 1 || u.llm_effective_engine_keys == null
          ? Number.MAX_SAFE_INTEGER
          : u.llm_effective_engine_keys.length;
      case "models":
        return admLlmAccessManageLabel(u) === "Oui" ? 1 : 0;
      case "sandbox":
        return u.sandbox_quota_mb > 0 ? (u.sandbox_used_mb || 0) / u.sandbox_quota_mb : 0;
      case "machines":
        return machinesAutorisees(u).length;
      default: {
        const v = (u as Record<string, unknown>)[champ];
        return typeof v === "string" ? v : Number(v) || 0;
      }
    }
  }
  const filteredSortedUsers = computed(() => {
    const q = usersSearch.value.trim().toLowerCase();
    let items = usersList.value;
    if (q)
      items = items.filter(
        (u) =>
          (u.username || "").toLowerCase().includes(q) || (u.group_names || "").toLowerCase().includes(q),
      );
    for (const f of usersFilters.value) {
      const test = FILTRES_COMPTES[f];
      if (test) items = items.filter(test);
    }
    const { field, dir } = usersSort.value;
    return [...items].sort((a, c) => {
      const va = valeurTri(a, field);
      const vb = valeurTri(c, field);
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      }
      return (va - vb) * dir;
    });
  });
  const usersPageCount = computed(() =>
    Math.max(1, Math.ceil(filteredSortedUsers.value.length / TAILLE_PAGE)),
  );
  const pagedUsers = computed(() => {
    const page = Math.min(usersPage.value, usersPageCount.value);
    return filteredSortedUsers.value.slice((page - 1) * TAILLE_PAGE, page * TAILLE_PAGE);
  });
  function toggleUsersSort(field: string): void {
    const s = usersSort.value;
    usersSort.value = s.field === field ? { field, dir: s.dir === 1 ? -1 : 1 } : { field, dir: 1 };
  }
  function toggleUsersFilter(f: string): void {
    usersFilters.value = usersFilters.value.includes(f)
      ? usersFilters.value.filter((x) => x !== f)
      : [...usersFilters.value, f];
  }
  watch([usersSearch, usersFilters], () => {
    usersPage.value = 1;
  });

  // ── Sélection et actions groupées ────────────────────────────────────────
  const comptesSelection: Ref<number[]> = ref([]);
  const comptesChoisis = computed(() => usersList.value.filter((u) => comptesSelection.value.includes(u.id)));
  const pageEntiereChoisie = computed(
    () => pagedUsers.value.length > 0 && pagedUsers.value.every((u) => comptesSelection.value.includes(u.id)),
  );
  function toggleCompteChoisi(id: number): void {
    comptesSelection.value = comptesSelection.value.includes(id)
      ? comptesSelection.value.filter((x) => x !== id)
      : [...comptesSelection.value, id];
  }
  function toggleToutesChoisies(): void {
    const ids = pagedUsers.value.map((u) => u.id);
    comptesSelection.value = pageEntiereChoisie.value
      ? comptesSelection.value.filter((x) => !ids.includes(x))
      : [...new Set([...comptesSelection.value, ...ids])];
  }
  const viderSelectionComptes = (): void => {
    comptesSelection.value = [];
  };
  watch(usersList, (liste) => {
    comptesSelection.value = comptesSelection.value.filter((id) => liste.some((u) => u.id === id));
  });
  const autresQueMoi = (): CompteConsole[] =>
    comptesChoisis.value.filter((u) => u.id !== refs.user.value?.id);

  /** Ajoute les comptes choisis au groupe, sans retirer leurs autres groupes. */
  async function ajouterSelectionAuGroupe(idGroupe: number): Promise<void> {
    const cibles = comptesChoisis.value.filter((u) => !u.group_ids.includes(idGroupe));
    let echecs = 0;
    for (const u of cibles) {
      try {
        const res = await fetchAuth(`/api/admin/users/${u.id}/groups`, {
          method: "PUT",
          headers: ENTETES_JSON,
          body: JSON.stringify({ group_ids: [...u.group_ids, idGroupe] }),
        });
        if (!res?.ok) echecs += 1;
      } catch {
        echecs += 1;
      }
    }
    await loadUsers();
    await loadGroups();
    const ok = cibles.length - echecs;
    showToast(
      echecs ? `${ok} compte(s) ajouté(s), ${echecs} échec(s)` : `${ok} compte(s) ajouté(s) au groupe`,
      echecs ? "warning" : "success",
    );
  }
  /** Supprime les comptes choisis (le vôtre excepté) après saisie du mot ; la sandbox suit le choix de la seconde question. */
  async function supprimerSelection(): Promise<void> {
    const cibles = autresQueMoi();
    if (!cibles.length) return;
    const noms = cibles.map((u) => u.username).join(", ");
    const confirme = await confirmerParMot(
      ctx,
      `Supprimer ${cibles.length} compte(s) ?`,
      `${noms}. Toutes leurs conversations seront supprimées. Action irréversible.`,
      "SUPPRIMER",
      "Supprimer",
    );
    if (!confirme) return;
    const avecBac = await openConfirm(
      "Supprimer également leurs sandboxes ?",
      "Tous les fichiers des sandboxes de ces comptes seraient supprimés.",
      true,
      "Supprimer les sandboxes",
      "Non, conserver",
    );
    let echecs = 0;
    for (const u of cibles) {
      try {
        const res = await fetchAuth(`/api/admin/users/${u.id}` + (avecBac ? "?delete_sandbox=true" : ""), {
          method: "DELETE",
        });
        if (!res?.ok) echecs += 1;
      } catch {
        echecs += 1;
      }
    }
    viderSelectionComptes();
    await loadUsers();
    void lien.loadAdminStats();
    const ok = cibles.length - echecs;
    showToast(
      echecs ? `${ok} compte(s) supprimé(s), ${echecs} échec(s)` : `${ok} compte(s) supprimé(s)`,
      echecs ? "warning" : "success",
    );
  }

  // ── Accès aux serveurs d'inférence ───────────────────────────────────────
  const admLlmAccessOptions: Ref<MoteurChoisissable[]> = ref([]);
  let optionsChargees = false;

  async function loadAdmLlmAccessOptions(force?: boolean): Promise<void> {
    if (optionsChargees && !force) return;
    try {
      const res = await fetchAuth("/api/admin/llm/engine-options");
      if (res?.ok) {
        admLlmAccessOptions.value = listeObjets(
          objet(await corpsJson(res))["engines"],
        ) as MoteurChoisissable[];
        optionsChargees = true;
      }
    } catch {
      /* options inchangées */
    }
  }
  const libelleMoteur = (cle: string): string =>
    admLlmAccessOptions.value.find((o) => o.key === cle)?.label ?? cle;

  function admLlmAccessServersLabel(u: CompteConsole | null | undefined): string {
    const eff = u?.llm_effective_engine_keys;
    if (!u || u.is_admin === 1 || eff == null) return "Tous";
    if (!eff.length) return "Aucun";
    const total = admLlmAccessOptions.value.length;
    return total ? `${eff.length} / ${total}` : String(eff.length);
  }
  function admLlmAccessServersTitle(u: CompteConsole | null | undefined): string {
    if (!u) return "";
    const src = SOURCES_ACCES[u.llm_engine_source] || "";
    const eff = u.llm_effective_engine_keys;
    if (u.is_admin === 1 || eff == null) return src;
    return src + (eff.length ? " — " + eff.map(libelleMoteur).join(", ") : " — aucun serveur");
  }
  const admLlmAccessManageLabel = (u: CompteConsole | null | undefined): string =>
    !u || u.llm_effective_can_manage_models !== false ? "Oui" : "Non";
  const admLlmAccessManageTitle = (u: CompteConsole | null | undefined): string =>
    u ? "Charger / décharger les modèles — " + (SOURCES_ACCES[u.llm_manage_source] || "") : "";

  async function enregistrerAcces(url: string, m: FormulaireAcces): Promise<boolean> {
    const { body, changed } = chargeAcces(m);
    if (!changed) return true;
    const res = await fetchAuth(url, { method: "PUT", headers: ENTETES_JSON, body: JSON.stringify(body) });
    if (res?.ok) return true;
    showToast(detailErreur(await corpsJson(res)) || "Accès aux serveurs non enregistré", "error");
    return false;
  }

  // ── Chargement des comptes ───────────────────────────────────────────────
  async function loadUsers(notifier?: unknown): Promise<void> {
    if (!refs.user.value?.is_admin) return;
    const ok = await suivreChargement(
      "loadUsers",
      async () => {
        const d = await lireSchema(
          await fetchAuth("/api/admin/users-with-groups"),
          schemaReponseComptesConsole,
        );
        if (!d) return false;
        usersList.value = d.users;
        usersNetProfiles.value = d.network_profiles as typeof usersNetProfiles.value;
        usersDesktopTargets.value = d.desktop_targets;
        void loadAdmLlmAccessOptions(notifier === true);
        return true;
      },
      () => loadUsers(),
    );
    if (notifier === true) {
      if (ok) showToast("Liste des utilisateurs rechargée", "success");
      else showToast("Échec du rechargement", "error");
    }
  }

  async function deleteUser(u: CompteConsole): Promise<void> {
    const confirme = await confirmerParMot(
      ctx,
      `Supprimer l'utilisateur "${u.username}" ?`,
      "Cette action est irréversible. Toutes ses conversations seront supprimées.",
      "SUPPRIMER",
      "Supprimer",
    );
    if (!confirme) return;
    const avecBac = await openConfirm(
      "Supprimer également sa sandbox ?",
      `Voulez-vous aussi supprimer tous les fichiers de la sandbox de "${u.username}" ?`,
      true,
      "Supprimer la sandbox",
      "Non, conserver",
    );
    try {
      const res = await fetchAuth(`/api/admin/users/${u.id}` + (avecBac ? "?delete_sandbox=true" : ""), {
        method: "DELETE",
      });
      if (res?.ok) {
        const data = objet(await corpsJson(res));
        if (data["sandbox_deleted"]) {
          showToast("Utilisateur et sandbox supprimés");
        } else if (data["sandbox_error"]) {
          showToast(
            `Utilisateur supprimé, sandbox NON supprimée : ${String(data["sandbox_error"])}`,
            "warning",
          );
        } else {
          showToast("Utilisateur supprimé" + (avecBac ? " (sandbox introuvable)" : ""));
        }
        const hotes = data["hosts_purge_errors"];
        if (Array.isArray(hotes) && hotes.length)
          showToast(
            `Identifiants de sites non purgés sur un hôte d'outils (${hotes.map(String).join(" ; ")}). Retirez-les avant de recréer un compte de ce nom.`,
            "warning",
          );
        void loadUsers();
        void lien.loadAdminStats();
      }
    } catch {
      /* suppression non confirmée */
    }
  }

  async function setUserSandboxQuota(u: CompteConsole, nouveauMo: unknown): Promise<void> {
    const mo = parseInt(String(nouveauMo), 10);
    if (isNaN(mo) || mo < 0) {
      showToast("Quota invalide", "error");
      return;
    }
    try {
      const res = await fetchAuth(`/api/admin/users/${u.id}/sandbox-quota`, {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ quota_mb: mo }),
      });
      if (res?.ok) {
        showToast(`Quota de ${u.username} : ${mo} Mo`);
        u.sandbox_quota_mb = mo;
      } else {
        showToast(detailErreur(await corpsJson(res)) || "Erreur", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  /** Impose un profil réseau (valeur vide : choix rendu au compte). L'événement est reçu pour réécrire le `<select>` en cas de refus. */
  async function setUserNetworkProfile(u: CompteConsole, ev?: Event): Promise<void> {
    const el = ev?.target instanceof HTMLSelectElement ? ev.target : null;
    const pid = String(el?.value || "");
    const avant = u.forced_network_profile_id || "";
    if (pid === avant) return;
    const retablir = (): void => {
      u.forced_network_profile_id = avant;
      if (el) el.value = avant;
    };
    if (pid) {
      const prof = usersNetProfiles.value.find((p) => p.id === pid);
      const ok = await openConfirm(
        `Imposer « ${prof ? prof.name : pid} » à ${u.username} ?`,
        "L'utilisateur ne pourra plus changer de profil réseau, et son conteneur sera recréé.",
        false,
        "Imposer",
      );
      if (!ok) {
        retablir();
        return;
      }
    }
    try {
      const res = await fetchAuth(`/api/admin/users/${u.id}/network-profile`, {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ profile_id: pid || null }),
      });
      if (res?.ok) {
        const d = objet(await res.json().catch(() => ({})));
        u.forced_network_profile_id =
          typeof d["forced_network_profile_id"] === "string" ? d["forced_network_profile_id"] : "";
        u.network_profile_id =
          typeof d["network_profile_id"] === "string" && d["network_profile_id"]
            ? d["network_profile_id"]
            : u.network_profile_id;
        showToast(pid ? `${u.username} : profil imposé` : `${u.username} : choix rendu`, "success");
      } else {
        retablir();
        showToast(detailErreur(await corpsJson(res)) || "Erreur", "error");
      }
    } catch {
      retablir();
      showToast("Erreur réseau", "error");
    }
  }

  // ── Réinitialisation du mot de passe ─────────────────────────────────────
  const resetTarget: Ref<CompteConsole | null> = ref(null);
  const newPasswordInput = ref("");
  const resetCibles: Ref<CompteConsole[]> = ref([]);
  function openResetModal(u: CompteConsole): void {
    resetCibles.value = [];
    resetTarget.value = u;
    newPasswordInput.value = "";
  }
  /** Un compte à la fois : un mot de passe temporaire commun ouvrirait chaque compte aux autres titulaires. */
  function reinitialiserSelection(): void {
    const cibles = autresQueMoi();
    if (cibles.length !== 1) return;
    resetCibles.value = [];
    resetTarget.value = cibles[0] ?? null;
    newPasswordInput.value = "";
  }
  function fermerReset(): void {
    resetTarget.value = null;
    resetCibles.value = [];
  }
  const resetLibelle = computed(() =>
    resetCibles.value.length ? `${resetCibles.value.length} comptes` : (resetTarget.value?.username ?? ""),
  );
  async function confirmReset(): Promise<void> {
    const cibles = resetCibles.value.length
      ? resetCibles.value
      : resetTarget.value
        ? [resetTarget.value]
        : [];
    if (!cibles.length || !newPasswordInput.value) return;
    let echecs = 0;
    let detail = "";
    for (const cible of cibles) {
      try {
        const res = await fetchAuth("/api/admin/reset-password", {
          method: "POST",
          headers: ENTETES_JSON,
          body: JSON.stringify({ target_id: cible.id, new_password: newPasswordInput.value }),
        });
        if (!res?.ok) {
          echecs += 1;
          detail = detailErreur(await corpsJson(res)) || "Erreur";
        }
      } catch {
        echecs += 1;
        detail = "Erreur réseau";
      }
    }
    if (!echecs) {
      showToast(cibles.length > 1 ? `Mot de passe changé pour ${cibles.length} comptes` : "Ok");
      fermerReset();
      newPasswordInput.value = "";
    } else {
      showToast(cibles.length > 1 ? `${echecs} échec(s) : ${detail}` : detail, "error");
    }
  }

  // ── Groupes ──────────────────────────────────────────────────────────────
  const allUsersWithGroups: Ref<CompteConsole[]> = ref([]);
  const modaleGroupeVide = (): ModaleGroupe => ({
    show: true,
    isEdit: false,
    id: null,
    name: "",
    description: "",
    ...formulaireAcces(null, null),
  });
  const groupModal: Ref<ModaleGroupe> = ref({ ...modaleGroupeVide(), show: false });
  const groupMembersModal: Ref<{ show: boolean; group: GroupeAffiche | null }> = ref({
    show: false,
    group: null,
  });

  async function loadGroups(): Promise<void> {
    await suivreChargement(
      "loadGroups",
      async () => {
        const d = await lireSchema(await fetchAuth("/api/admin/groups"), schemaReponseGroupesConsole);
        if (!d) return false;
        groupsList.value = d.groups;
        return true;
      },
      () => loadGroups(),
    );
  }
  async function loadAllUsersWithGroups(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/users-with-groups"),
        schemaReponseComptesConsole,
      );
      if (d) allUsersWithGroups.value = d.users;
    } catch {
      /* liste inchangée */
    }
  }
  function openCreateGroup(): void {
    groupModal.value = modaleGroupeVide();
    void loadAdmLlmAccessOptions(true);
  }
  function openEditGroup(g: GroupeAffiche): void {
    groupModal.value = {
      show: true,
      isEdit: true,
      id: g.id,
      name: g.name,
      description: g.description || "",
      ...formulaireAcces(g.llm_engine_keys, g.llm_can_manage_models),
    };
    void loadAdmLlmAccessOptions(true);
  }
  async function saveGroup(): Promise<void> {
    const m = groupModal.value;
    if (!m.name.trim()) return;
    const url = m.isEdit ? `/api/admin/groups/${m.id}` : "/api/admin/groups";
    try {
      const res = await fetchAuth(url, {
        method: m.isEdit ? "PUT" : "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ name: m.name.trim(), description: m.description.trim() }),
      });
      if (res?.ok) {
        const cree = m.isEdit ? null : objet(await res.json().catch(() => ({})));
        const gid = m.isEdit ? m.id : typeof cree?.["id"] === "number" ? cree["id"] : null;
        if (gid && !(await enregistrerAcces(`/api/admin/groups/${gid}/llm-access`, m))) {
          await loadGroups();
          if (!m.isEdit) groupModal.value = { ...m, isEdit: true, id: gid };
          return;
        }
        groupModal.value.show = false;
        await loadGroups();
        await loadUsers();
        showToast(m.isEdit ? "Groupe modifié" : "Groupe créé");
      } else {
        showToast(detailErreur(await corpsJson(res)) || "Erreur", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }
  async function confirmDeleteGroup(g: GroupeAffiche): Promise<void> {
    const ok = await openConfirm(
      `Supprimer "${g.name}" ?`,
      `Les ${g.member_count} membre(s) seront désaffectés.`,
      true,
    );
    if (!ok) return;
    try {
      const res = await fetchAuth(`/api/admin/groups/${g.id}`, { method: "DELETE" });
      if (res?.ok) {
        await loadGroups();
        await loadUsers();
        showToast("Groupe supprimé");
      }
    } catch {
      /* suppression non confirmée */
    }
  }
  async function openGroupMembers(g: GroupeAffiche): Promise<void> {
    groupMembersModal.value = { show: true, group: g };
    await loadAllUsersWithGroups();
  }
  function isInCurrentGroup(u: CompteConsole): boolean {
    const gid = groupMembersModal.value.group?.id;
    return gid ? u.group_ids.includes(gid) : false;
  }
  async function toggleMembership(u: CompteConsole): Promise<void> {
    const gid = groupMembersModal.value.group?.id;
    if (!gid) return;
    const dedans = isInCurrentGroup(u);
    const nouveaux = dedans ? u.group_ids.filter((x) => x !== gid) : [...u.group_ids, gid];
    try {
      const res = await fetchAuth(`/api/admin/users/${u.id}/groups`, {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify({ group_ids: nouveaux }),
      });
      if (res?.ok) {
        await loadAllUsersWithGroups();
        await loadGroups();
        await loadUsers();
      }
    } catch {
      /* appartenance inchangée */
    }
  }

  // ── Éditeur de compte en ligne ───────────────────────────────────────────
  const userEdit: Ref<EditionCompte | null> = ref(null);
  const admRoleLabel = (u: CompteConsole): string =>
    ({ admin: "Administrateur", moderator: "Modérateur", user: "Utilisateur" })[roleDe(u)] ?? "Utilisateur";
  function admNetProfileName(id: string): string {
    const p = usersNetProfiles.value.find((x) => x.id === id);
    return p ? p.name : id || "—";
  }
  function machinesAutorisees(u: CompteConsole): string[] {
    const ts = usersDesktopTargets.value;
    if (u.is_admin === 1) return ts.map((t) => t.name);
    return ts
      .filter((t) => t.access !== "list" || (t.allowed_users || []).includes(u.username))
      .map((t) => t.name);
  }
  function admDesktopLabel(u: CompteConsole): string {
    const total = usersDesktopTargets.value.length;
    if (!total) return "—";
    const n = machinesAutorisees(u).length;
    return n === total ? "Toutes" : n ? `${n} / ${total}` : "Aucune";
  }
  function admDesktopTitle(u: CompteConsole): string {
    if (u.is_admin === 1) return "Administrateur : toutes les machines";
    const noms = machinesAutorisees(u);
    return noms.length ? noms.join(", ") : "Aucune machine pilotable";
  }
  function instantaneEdition(ed: EditionCompte): string {
    return JSON.stringify({
      role: ed.role,
      groups: [...ed.groups].sort(),
      llm: chargeAcces(ed).body,
      quota: ed.quota,
      network: ed.network,
      desktop: [...ed.desktop].sort(),
    });
  }
  /** Accès par jeton du compte (jetons personnels, applications OAuth) : tout se coupe d'un geste. */
  async function loadUserAccess(id: number): Promise<void> {
    try {
      const r = await fetchAuth(`/api/admin/users/${id}/access`, {}, true);
      const d = (await lireSchema(r, schemaReponseAccesCompte)) ?? { tokens: [], grants: [] };
      if (userEdit.value && userEdit.value.id === id) userEdit.value = { ...userEdit.value, access: d };
    } catch {
      /* la ligne reste « Chargement… » */
    }
  }
  async function revokeUserAccess(u: CompteConsole): Promise<void> {
    const ok = await openConfirm(
      "Révoquer les accès par jeton ?",
      `Tous les jetons personnels et applications autorisées de ${u.username} seront révoqués.`,
      true,
      "Révoquer",
    );
    if (!ok) return;
    const r = await fetchAuth(`/api/admin/users/${u.id}/access/revoke`, { method: "POST" }, true);
    if (r?.ok) {
      showToast("Accès par jeton révoqués.");
      void loadUserAccess(u.id);
    } else showToast("Révocation impossible.", "error");
  }
  const userEditOpen = (u: CompteConsole): boolean => !!(userEdit.value && userEdit.value.id === u.id);
  const closeUserEdit = (): void => {
    userEdit.value = null;
  };
  function toggleUserEdit(u: CompteConsole): void {
    if (userEditOpen(u)) {
      closeUserEdit();
      return;
    }
    const ed: EditionCompte = {
      id: u.id,
      user: u,
      saving: false,
      role: roleDe(u),
      groups: u.group_ids ? [...u.group_ids] : [],
      ...formulaireAcces(u.llm_engine_keys, u.llm_can_manage_models),
      quota: Number(u.sandbox_quota_mb) || 0,
      network: u.forced_network_profile_id || "",
      desktop: usersDesktopTargets.value
        .filter((t) => t.access === "list" && (t.allowed_users || []).includes(u.username))
        .map((t) => t.name),
      _orig: "",
    };
    ed._orig = instantaneEdition(ed);
    userEdit.value = ed;
    void loadAdmLlmAccessOptions(true);
    void loadUserAccess(u.id);
    void ctx.nextTick().then(() => {
      const el =
        document.querySelector<HTMLElement>(`#user-edit-${u.id} [data-user-edit-first]`) ??
        document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `#user-edit-${u.id} input, #user-edit-${u.id} select`,
        );
      if (el && !(el as HTMLInputElement).disabled) el.focus();
    });
  }
  const userEditDirty = computed(
    () => !!userEdit.value && instantaneEdition(userEdit.value) !== userEdit.value._orig,
  );

  async function appelEdition(
    url: string,
    methode: string,
    corps: unknown,
    quoi: string,
  ): Promise<Response | null> {
    const res = await fetchAuth(url, { method: methode, headers: ENTETES_JSON, body: JSON.stringify(corps) });
    if (res?.ok) return res;
    showToast(detailErreur(await corpsJson(res)) || `${quoi} : échec`, "error");
    return null;
  }

  /** Les listes `allowed_users` vivent dans config.json : le formulaire Connexions chargé doit les reprendre, sans se croire modifié. */
  function synchroniserFormulaireMachines(cibles: unknown): void {
    if (!Array.isArray(cibles)) return;
    const machines = cibles as { name: string; os: string; access: string; allowed_users: string[] }[];
    usersDesktopTargets.value = machines;
    const form = e.configForm.value?.desktop?.targets;
    if (!Array.isArray(form)) return;
    const etaitPropre =
      e.adminPristine.value.config === null || e.adminPristine.value.config === lien.storeSnapshot("config");
    for (const t of form) {
      const n = machines.find((x) => x.name === t.name);
      if (n) t.allowed_users = [...(n.allowed_users || [])];
    }
    const brutes = lireChemin(e.configRaw, "desktop.targets");
    if (brutes.found && Array.isArray(brutes.value)) {
      for (const t of brutes.value as { name?: string; allowed_users?: string[] }[]) {
        const n = machines.find((x) => x.name === t.name);
        if (n) t.allowed_users = [...(n.allowed_users || [])];
      }
    }
    if (etaitPropre) lien.markAdminStoreClean("config");
  }

  /** Un seul Enregistrer n'envoie que ce qui a changé, dans l'ordre rôle, groupes, inférence, quota, réseau, machines. */
  async function saveUserEdit(): Promise<void> {
    const ed = userEdit.value;
    if (!ed || ed.saving || !userEditDirty.value) return;
    const u = ed.user;
    const o = objet(JSON.parse(ed._orig));
    const quota = parseInt(String(ed.quota), 10);
    if (isNaN(quota) || quota < 0) {
      showToast("Quota invalide", "error");
      return;
    }
    if (ed.network && ed.network !== o["network"]) {
      const prof = usersNetProfiles.value.find((p) => p.id === ed.network);
      const ok = await openConfirm(
        `Imposer « ${prof ? prof.name : ed.network} » à ${u.username} ?`,
        "Son profil réseau sera verrouillé et son conteneur recréé.",
        false,
        "Imposer",
      );
      if (!ok) return;
    }
    ed.saving = true;
    const base = `/api/admin/users/${u.id}`;
    let ok = true;
    try {
      if (ok && ed.role !== o["role"])
        ok = !!(await appelEdition(`${base}/role`, "POST", { role: ed.role }, "Rôle"));
      if (ok && JSON.stringify([...ed.groups].sort()) !== JSON.stringify(o["groups"]))
        ok = !!(await appelEdition(`${base}/groups`, "PUT", { group_ids: ed.groups }, "Groupes"));
      if (ok) ok = await enregistrerAcces(`${base}/llm-access`, ed);
      if (ok && quota !== o["quota"])
        ok = !!(await appelEdition(`${base}/sandbox-quota`, "POST", { quota_mb: quota }, "Quota"));
      if (ok && ed.network !== o["network"])
        ok = !!(await appelEdition(
          `${base}/network-profile`,
          "POST",
          { profile_id: ed.network || null },
          "Réseau",
        ));
      if (ok && JSON.stringify([...ed.desktop].sort()) !== JSON.stringify(o["desktop"])) {
        const r = await appelEdition(`${base}/desktop-targets`, "PUT", { targets: ed.desktop }, "Machines");
        ok = !!r;
        if (r) {
          const d = await lireSchema(r, schemaReponseMachinesCompte);
          synchroniserFormulaireMachines(d?.desktop_targets);
        }
      }
    } catch {
      ok = false;
      showToast("Erreur réseau", "error");
    }
    ed.saving = false;
    await loadUsers();
    if (ok) {
      closeUserEdit();
      showToast(`${u.username} : réglages enregistrés`);
    }
  }

  return {
    usersList,
    usersNetProfiles,
    usersDesktopTargets,
    usersSearch,
    usersSort,
    usersFilters,
    toggleUsersFilter,
    comptesSelection,
    comptesChoisis,
    pageEntiereChoisie,
    toggleCompteChoisi,
    toggleToutesChoisies,
    viderSelectionComptes,
    ajouterSelectionAuGroupe,
    supprimerSelection,
    reinitialiserSelection,
    resetCibles,
    resetLibelle,
    fermerReset,
    usersPage,
    usersPageCount,
    pagedUsers,
    filteredSortedUsers,
    toggleUsersSort,
    loadUsers,
    deleteUser,
    setUserSandboxQuota,
    setUserNetworkProfile,
    resetTarget,
    newPasswordInput,
    openResetModal,
    confirmReset,
    groupsList,
    allUsersWithGroups,
    groupModal,
    groupMembersModal,
    loadGroups,
    saveGroup,
    openCreateGroup,
    openEditGroup,
    confirmDeleteGroup,
    openGroupMembers,
    isInCurrentGroup,
    toggleMembership,
    admLlmAccessOptions,
    loadAdmLlmAccessOptions,
    admLlmAccessServersLabel,
    admLlmAccessServersTitle,
    admLlmAccessManageLabel,
    admLlmAccessManageTitle,
    userEdit,
    userEditDirty,
    userEditOpen,
    toggleUserEdit,
    closeUserEdit,
    saveUserEdit,
    revokeUserAccess,
    admRoleLabel,
    admNetProfileName,
    admDesktopLabel,
    admDesktopTitle,
  };
}
