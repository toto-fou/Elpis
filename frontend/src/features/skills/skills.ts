// SPDX-License-Identifier: MIT
/** frontend/src/features/skills/skills.ts — onglet Skills des Paramètres : inventaire par portée, arbre, détail, création, modification, suppression, promotion, import (zip, dossier, SKILL.md) et export. */
import { computed, ref } from "vue";
import type { Ref } from "vue";
import type { ResumeSkill } from "@elpis/contracts";

import { marquerDepotTraite } from "../../utils/depot";
import type { ApiSkills, CorpsEcritureSkill, EcritureSkill, ResultatImport } from "./api";
import {
  PORTEES,
  clesDepliables,
  construireArbres,
  descendants,
  enfants,
  filDAriane,
  filtrerInventaire,
  inventaireVide,
  libellePortee,
  retirerFrontmatter,
  slugClient,
} from "./arbre";
import type { InventaireSkills, NoeudSkill, Portee } from "./arbre";

export interface FormulaireSkill {
  scope: Portee;
  name: string;
  description: string;
  domain: string;
  tags: string;
  body: string;
  _original: string;
  _depth: number;
}

export interface DetailSkill extends ResumeSkill {
  body?: string;
}

export interface FichierOuvert {
  path: string;
  content: string;
  loading: boolean;
}

export interface CtxSkills {
  showToast(message: string, type?: string, options?: { duration?: number }): void;
  openConfirm(titre: string, texte: string, danger?: boolean, ok?: string): Promise<boolean>;
  announce(message: string): void;
  nextTick(fn: () => void): unknown;
}

export interface RefsSkills {
  user: Ref<{ role?: string } | null>;
}

interface EntreeImport {
  file: File;
  relPath: string;
}

const TAILLE_MD_MAX = 1024 * 1024;

function formulaireVide(): FormulaireSkill {
  return {
    scope: "user",
    name: "",
    description: "",
    domain: "",
    tags: "",
    body: "",
    _original: "",
    _depth: 0,
  };
}

export function creerSkills(api: ApiSkills, refs: RefsSkills, ctx: CtxSkills) {
  const { user } = refs;
  const { showToast, openConfirm, announce, nextTick } = ctx;

  const skillsLoading = ref(false);
  const skillsError = ref("");
  const skillsBusy = ref(false);
  const skillsFilter = ref("");
  const skillsByScope = ref<InventaireSkills>(inventaireVide());
  const skillEditMode = ref("");
  const skillDetail = ref<DetailSkill | null>(null);
  const skillForm = ref<FormulaireSkill>(formulaireVide());
  const skillFileView = ref<FichierOuvert | null>(null);
  const collapsedSkills = ref(new Set<string>());
  const showSkillImportMenu = ref(false);
  const importMenuBtn = ref<HTMLElement | null>(null);
  const skillsImporting = ref("");
  const skillBodyView = ref("rendered");
  const skillsDragOver = ref(false);
  let profondeurDrag = 0;
  // Jeton de navigation : un fetch de corps qui revient après une navigation est ignoré.
  let navSeq = 0;
  let fichierSeq = 0;

  const isAdmin = computed(() => !!(user.value && user.value.role === "admin"));

  function notifierChangement(): void {
    try {
      window.dispatchEvent(new CustomEvent("skills:changed"));
    } catch {
      /* aucun écouteur à prévenir */
    }
  }

  const editableScopes = computed<Portee[]>(() => (isAdmin.value ? ["user", "learned", "global"] : ["user"]));
  function canEditScope(scope: string): boolean {
    return (editableScopes.value as string[]).indexOf(scope) !== -1;
  }

  const filteredByScope = computed(() => filtrerInventaire(skillsByScope.value, skillsFilter.value));
  const totalSkillsCount = computed(() =>
    PORTEES.reduce((n, p) => n + (skillsByScope.value[p] || []).length, 0),
  );
  const aucunSkillPerso = computed(() => !(skillsByScope.value.user || []).length);
  const filteredTotalCount = computed(() =>
    PORTEES.reduce((n, p) => n + (filteredByScope.value[p] || []).length, 0),
  );
  const skillsTreeByScope = computed(() => construireArbres(filteredByScope.value));

  function resetEditor(): void {
    navSeq++;
    skillEditMode.value = "";
    skillDetail.value = null;
    skillFileView.value = null;
    skillBodyView.value = "rendered";
    skillForm.value = formulaireVide();
  }

  function openSkillsTab(): void {
    showSkillImportMenu.value = false;
    skillsDragOver.value = false;
    profondeurDrag = 0;
    resetEditor();
    void loadAllSkills(true);
  }

  function closeSkillImportMenu(): void {
    if (!showSkillImportMenu.value) return;
    showSkillImportMenu.value = false;
    nextTick(() => {
      try {
        importMenuBtn.value?.focus();
      } catch {
        /* déclencheur retiré du DOM */
      }
    });
  }

  /** Seul `true` strict replie l'arbre : une référence de méthode reçoit sinon l'événement du clic. */
  async function loadAllSkills(resetCollapse?: unknown): Promise<void> {
    const replier = resetCollapse === true;
    skillsLoading.value = true;
    skillsError.value = "";
    try {
      const resultats = await Promise.all(
        PORTEES.map(async (scope) => [scope, await api.parPortee(scope)] as const),
      );
      const suivant = inventaireVide();
      for (const [scope, liste] of resultats) suivant[scope] = liste;
      skillsByScope.value = suivant;
      if (replier) {
        const t = skillsTreeByScope.value;
        collapsedSkills.value = clesDepliables([...t.user, ...t.learned, ...t.global]);
      }
    } catch {
      skillsError.value = "Impossible de charger les skills.";
      showToast("Erreur chargement des skills", "error");
    } finally {
      skillsLoading.value = false;
    }
  }

  async function viewSkill(sk: ResumeSkill | undefined): Promise<void> {
    if (!sk) return;
    const seq = ++navSeq;
    skillEditMode.value = "view";
    skillFileView.value = null;
    skillBodyView.value = "rendered";
    skillDetail.value = Object.assign({}, sk, { body: (sk as DetailSkill).body || sk.body_preview || "" });
    const contenu = await api.corpsComplet(sk.id || sk.name, sk.source || "user");
    if (seq === navSeq && typeof contenu === "string") {
      skillDetail.value = Object.assign({}, sk, { body: retirerFrontmatter(contenu) });
    }
  }

  function startCreate(): void {
    navSeq++;
    skillEditMode.value = "create";
    skillDetail.value = null;
    skillForm.value = Object.assign(formulaireVide(), { scope: "user" as Portee });
  }

  async function startEdit(sk: DetailSkill): Promise<void> {
    const seq = ++navSeq;
    skillEditMode.value = "edit";
    let body = sk.body || "";
    const complet = await api.corpsPourEdition(sk.name, sk.source || "user", sk.id || sk.name);
    if (complet) body = complet || body;
    if (seq !== navSeq) return;
    skillForm.value = {
      scope: (sk.source || "user") as Portee,
      name: sk.name || "",
      description: sk.description || "",
      domain: sk.domain || "",
      tags: Array.isArray(sk.tags) ? sk.tags.join(", ") : String(sk.tags || ""),
      body,
      _original: sk.id || sk.name || "",
      _depth: sk.depth || 0,
    };
    skillDetail.value = sk;
  }

  function cancelEdit(): void {
    resetEditor();
  }
  function backToSkillsList(): void {
    resetEditor();
  }

  async function saveSkill(): Promise<void> {
    const f = skillForm.value;
    if (!f.name.trim() || !f.body.trim()) {
      showToast("Nom et corps requis", "error");
      return;
    }
    if (!canEditScope(f.scope)) {
      showToast("Réservé aux administrateurs", "error");
      return;
    }
    skillsBusy.value = true;
    try {
      const edition = skillEditMode.value === "edit";
      const tags = String(f.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const corps: CorpsEcritureSkill = {
        scope: f.scope,
        name: f.name.trim(),
        description: f.description || "",
        body: f.body,
        tags,
        domain: f.domain || undefined,
      };
      const original = String(f._original || f.name.trim());
      const res = await api.ecrire(
        corps,
        edition ? { feuille: original.split("/").pop() ?? original, original } : null,
      );
      if (res.ok) {
        showToast(edition ? "Skill mis à jour" : "Skill créé");
        resetEditor();
        await loadAllSkills();
        notifierChangement();
      } else if (res.statut === 409) showToast("Un skill de ce nom existe déjà — édite-le plutôt", "error");
      else if (res.statut === 403) showToast("Action réservée aux administrateurs", "error");
      else if (res.statut === 0) showToast("Erreur réseau", "error");
      else showToast(res.detail || "Erreur enregistrement", "error");
    } finally {
      skillsBusy.value = false;
    }
  }

  async function deleteSkill(sk: ResumeSkill): Promise<void> {
    const scope = (sk.source || "user") as Portee;
    if (!canEditScope(scope)) {
      showToast("Suppression réservée aux administrateurs", "error");
      return;
    }
    const id = sk.id || sk.name;
    const kids = descendants(skillsByScope.value, scope, id);
    let label = sk.name + (scope !== "user" ? ` (${scope})` : "");
    if (kids.length)
      label += ` — supprime aussi ${kids.length} sous-skill(s) et tous les fichiers du dossier`;
    else if (sk.is_folder && (sk.files || []).length)
      label += ` — supprime le dossier et ses ${sk.files.length} fichier(s)`;
    const ok = await openConfirm("Supprimer ce skill ?", label, true);
    if (!ok) return;
    skillsBusy.value = true;
    try {
      const res = await api.supprimer(String(id).split("/").pop() ?? id, scope, id);
      if (res.ok) {
        showToast("Skill supprimé");
        const cur = skillDetail.value;
        const curId = cur ? cur.id || cur.name : "";
        if (cur && (cur.source || "user") === scope && (curId === id || curId.indexOf(`${id}/`) === 0))
          resetEditor();
        await loadAllSkills();
        notifierChangement();
      } else if (res.statut === 403) showToast("Suppression réservée aux administrateurs", "error");
      else if (res.statut === 404) showToast("Skill introuvable", "error");
      else if (res.statut === 0) showToast("Erreur réseau", "error");
      else showToast("Suppression impossible", "error");
    } finally {
      skillsBusy.value = false;
    }
  }

  async function promoteSkill(sk: ResumeSkill): Promise<void> {
    if (!isAdmin.value) {
      showToast("Promotion réservée aux administrateurs", "error");
      return;
    }
    const ok = await openConfirm(
      "Promouvoir vers global ?",
      `${sk.name} sera visible par tous les utilisateurs.`,
      false,
      "Promouvoir",
    );
    if (!ok) return;
    skillsBusy.value = true;
    try {
      const res = await api.promouvoir(sk.name);
      if (res.ok) {
        showToast("Skill promu en global");
        if (skillDetail.value && skillDetail.value.name === sk.name) resetEditor();
        await loadAllSkills();
        notifierChangement();
      } else if (res.statut === 403) showToast("Promotion réservée aux administrateurs", "error");
      else if (res.statut === 0) showToast("Erreur réseau", "error");
      else showToast(res.detail || "Promotion impossible (conflit de nom ?)", "error");
    } finally {
      skillsBusy.value = false;
    }
  }

  const scopeLabel = libellePortee;

  function verifierPortee(scope: unknown): Portee | null {
    const sc: Portee = scope === "global" ? "global" : "user";
    if (sc === "global" && !isAdmin.value) {
      showToast("Import global réservé aux administrateurs", "error");
      return null;
    }
    return sc;
  }

  /** Sélection automatique du skill importé : déplie son domaine et ouvre le détail. */
  function selectionnerImporte(name: string | undefined, sc: Portee): void {
    if (!name) return;
    const sk = (skillsByScope.value[sc] || []).find((s) => (s.id || s.name) === name || s.name === name);
    if (!sk) return;
    const ouvert = new Set(collapsedSkills.value);
    const dom = (sk.domain || "").trim();
    if (dom) ouvert.delete(`${sc}:dom:${dom}`);
    ouvert.delete(`${sc}:${sk.id || sk.name}`);
    collapsedSkills.value = ouvert;
    void viewSkill(sk);
  }

  async function traiterReponseImport(
    res: EcritureSkill<ResultatImport>,
    nomParDefaut: string,
    reessayer: (ecraser: boolean) => Promise<void>,
  ): Promise<void> {
    if (res.ok) {
      const data = res.valeur;
      const imported = data.imported;
      const name = data.name || nomParDefaut || "skill";
      showToast(imported.length > 1 ? `${imported.length} skills importés` : `Skill « ${name} » importé`);
      announce(`Skill ${name} importé`);
      await loadAllSkills();
      notifierChangement();
      selectionnerImporte(data.name, data.scope === "global" ? "global" : "user");
      return;
    }
    if (res.statut === 0) return;
    if (res.statut === 403) {
      showToast("Import global réservé aux administrateurs", "error");
      return;
    }
    if (res.statut === 409) {
      const d = (res.brut ?? {}) as { name?: string };
      const name = d.name || nomParDefaut || "skill";
      const ok = await openConfirm(
        `Remplacer le skill « ${name} » ?`,
        "Un skill du même nom existe déjà. Le remplacer écrase son contenu et tous ses fichiers.",
        true,
        "Remplacer",
      );
      if (ok) await reessayer(true);
      return;
    }
    showToast(res.detail || "Import refusé : archive invalide ou SKILL.md manquant", "error", {
      duration: 8000,
    });
  }

  function viderChamp(cible: EventTarget | null): void {
    try {
      if (cible) (cible as HTMLInputElement).value = "";
    } catch {
      /* champ de fichier en lecture seule */
    }
  }

  async function postZip(file: File, sc: Portee, ecraser: boolean): Promise<void> {
    skillsImporting.value = "zip";
    announce("Import du skill en cours");
    try {
      const res = await api.importerZip(file, sc, ecraser);
      await traiterReponseImport(res, String(file.name || "").replace(/\.zip$/i, ""), (ow) =>
        postZip(file, sc, ow),
      );
    } finally {
      skillsImporting.value = "";
    }
  }

  /** Accepte un fichier ou l'événement `change` d'un `<input type=file>` caché. */
  async function importSkillZip(fichierOuEvt: File | Event | null, scope?: string): Promise<void> {
    const cible =
      fichierOuEvt && "target" in fichierOuEvt ? (fichierOuEvt.target as HTMLInputElement | null) : null;
    const file = cible ? (cible.files || [])[0] : (fichierOuEvt as File | null);
    if (cible) viderChamp(cible);
    if (!file) return;
    const sc = verifierPortee(scope);
    if (!sc) return;
    await postZip(file, sc, false);
  }

  async function postFolder(entrees: EntreeImport[], sc: Portee, ecraser: boolean): Promise<void> {
    skillsImporting.value = "folder";
    announce("Import du skill en cours");
    try {
      const res = await api.importerDossier(entrees, sc, ecraser);
      const racine = String(entrees[0]?.relPath || "").split("/")[0] || "skill";
      await traiterReponseImport(res, racine, (ow) => postFolder(entrees, sc, ow));
    } finally {
      skillsImporting.value = "";
    }
  }

  async function importSkillFolder(evt: Event | null, scope?: string): Promise<void> {
    const cible = (evt && (evt.target as HTMLInputElement | null)) || null;
    const files = Array.from((cible && cible.files) || []);
    viderChamp(cible);
    if (!files.length) return;
    const sc = verifierPortee(scope);
    if (!sc) return;
    await postFolder(
      files.map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })),
      sc,
      false,
    );
  }

  async function postMd(rawMd: string, filename: string, sc: Portee): Promise<void> {
    skillsImporting.value = "md";
    announce("Import du skill en cours");
    const stem = String(filename || "").replace(/\.(md|markdown)$/i, "");
    try {
      const res = await api.ecrire({ scope: sc, raw_md: rawMd, filename }, null);
      if (res.ok) {
        const name = res.valeur.name || stem;
        showToast(`Skill « ${name} » importé`);
        announce(`Skill ${name} importé`);
        await loadAllSkills();
        notifierChangement();
        selectionnerImporte(slugClient(name), sc);
        return;
      }
      if (res.statut === 0) return;
      if (res.statut === 403) {
        showToast("Import global réservé aux administrateurs", "error");
        return;
      }
      if (res.statut === 409) {
        const m = /'([^']+)'/.exec(String(res.detail || ""));
        const slug = (m && m[1]) || slugClient(stem);
        const ok = await openConfirm(
          `Remplacer le skill « ${slug} » ?`,
          "Un skill du même nom existe déjà. Le remplacer écrase son contenu.",
          true,
          "Remplacer",
        );
        if (!ok) return;
        const res2 = await api.remplacerMd(slug, { scope: sc, raw_md: rawMd, filename });
        if (res2.ok) {
          showToast(`Skill « ${res2.valeur.name || slug} » remplacé`);
          await loadAllSkills();
          notifierChangement();
          selectionnerImporte(slug, sc);
        } else if (res2.statut !== 0) {
          showToast(res2.detail || "Remplacement impossible", "error", { duration: 8000 });
        }
        return;
      }
      showToast(res.detail || "Import refusé : SKILL.md invalide", "error", { duration: 8000 });
    } finally {
      skillsImporting.value = "";
    }
  }

  async function importSkillMd(evt: Event | null, scope?: string): Promise<void> {
    const cible = (evt && (evt.target as HTMLInputElement | null)) || null;
    const file = (cible && (cible.files || [])[0]) || null;
    viderChamp(cible);
    if (!file) return;
    const sc = verifierPortee(scope);
    if (!sc) return;
    if (file.size > TAILLE_MD_MAX) {
      showToast("Fichier .md trop volumineux (1 Mo max — utilise l'import dossier/zip)", "error");
      return;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      showToast("Lecture du fichier impossible", "error");
      return;
    }
    await postMd(raw, file.name, sc);
  }

  function dragContientFichiers(event: DragEvent): boolean {
    try {
      const types = event.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    } catch {
      /* transfert illisible */
    }
    return false;
  }

  function onSkillsDragEnter(event: DragEvent): void {
    if (!dragContientFichiers(event)) return;
    event.preventDefault();
    profondeurDrag++;
    skillsDragOver.value = true;
  }
  function onSkillsDragOver(event: DragEvent): void {
    if (!dragContientFichiers(event)) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    skillsDragOver.value = true;
  }
  function onSkillsDragLeave(event: DragEvent): void {
    if (!dragContientFichiers(event)) return;
    profondeurDrag = Math.max(0, profondeurDrag - 1);
    if (profondeurDrag === 0) skillsDragOver.value = false;
  }

  function lireToutesEntrees(lecteur: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
      const sortie: FileSystemEntry[] = [];
      const etape = (): void => {
        lecteur.readEntries((lot) => {
          if (!lot.length) {
            resolve(sortie);
            return;
          }
          for (const b of lot) sortie.push(b);
          etape();
        }, reject);
      };
      etape();
    });
  }

  async function collecterDossier(
    dir: FileSystemDirectoryEntry,
    prefixe: string,
    acc: EntreeImport[],
  ): Promise<void> {
    const fils = await lireToutesEntrees(dir.createReader());
    for (const en of fils) {
      if (!en || !en.name || en.name.charAt(0) === ".") continue;
      if (acc.length > 500) return;
      if (en.isDirectory) {
        await collecterDossier(en as FileSystemDirectoryEntry, `${prefixe}/${en.name}`, acc);
      } else if (en.isFile) {
        const file = await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej));
        acc.push({ file, relPath: `${prefixe}/${en.name}` });
      }
    }
  }

  async function onSkillsDrop(event: DragEvent): Promise<void> {
    profondeurDrag = 0;
    skillsDragOver.value = false;
    marquerDepotTraite();
    const dt = event && event.dataTransfer;
    if (!dt) return;
    const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === "file") : [];
    const premier = items[0];
    const entry =
      items.length === 1 && premier && premier.webkitGetAsEntry ? premier.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      const sc = verifierPortee("user");
      if (!sc) return;
      const collectes: EntreeImport[] = [];
      try {
        await collecterDossier(entry as FileSystemDirectoryEntry, entry.name, collectes);
      } catch {
        showToast("Lecture du dossier déposé impossible", "error");
        return;
      }
      if (!collectes.length) {
        showToast("Dossier vide (ou uniquement des fichiers cachés)", "error");
        return;
      }
      if (collectes.length > 500) {
        showToast("Trop de fichiers (500 max)", "error");
        return;
      }
      await postFolder(collectes, sc, false);
      return;
    }
    const files = Array.from(dt.files || []);
    const f = files[0];
    if (files.length !== 1 || !f) {
      showToast("Dépose un seul élément : archive .zip, dossier de skill ou fichier SKILL.md", "error");
      return;
    }
    const sc = verifierPortee("user");
    if (!sc) return;
    if (/\.zip$/i.test(f.name || "")) {
      await postZip(f, sc, false);
      return;
    }
    if (/\.(md|markdown)$/i.test(f.name || "")) {
      if (f.size > TAILLE_MD_MAX) {
        showToast("Fichier .md trop volumineux (1 Mo max)", "error");
        return;
      }
      let raw: string;
      try {
        raw = await f.text();
      } catch {
        showToast("Lecture du fichier impossible", "error");
        return;
      }
      await postMd(raw, f.name, sc);
      return;
    }
    showToast("Format non géré — dépose un .zip, un dossier de skill ou un SKILL.md", "error");
  }

  function exportSkillZip(sk: ResumeSkill | null): void {
    if (!sk || !sk.name) return;
    let url = `/api/skills/${encodeURIComponent(sk.name)}/export`;
    const qp: string[] = [];
    if (sk.source) qp.push(`scope=${encodeURIComponent(sk.source)}`);
    if (sk.id && sk.id !== sk.name) qp.push(`id=${encodeURIComponent(sk.id)}`);
    if (qp.length) url += `?${qp.join("&")}`;
    try {
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      a.download = `${sk.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      showToast("Téléchargement impossible", "error");
    }
  }

  function toggleCollapse(key: string): void {
    const s = new Set(collapsedSkills.value);
    if (s.has(key)) s.delete(key);
    else s.add(key);
    collapsedSkills.value = s;
  }

  const selectedNodeKey = computed(() => {
    const d = skillDetail.value;
    return d ? `${d.source || "user"}:${d.id || d.name}` : "";
  });
  const activeFileNodeKey = computed(() => {
    const f = skillFileView.value;
    return f && f.path && selectedNodeKey.value ? `${selectedNodeKey.value}::${f.path}` : "";
  });

  async function openSkillFile(sk: ResumeSkill | null, path: string): Promise<void> {
    if (!sk) return;
    const mySeq = ++fichierSeq;
    skillFileView.value = { path, content: "", loading: true };
    const contenu = await api.fichier(sk.id || sk.name, path, sk.source || "user");
    if (mySeq !== fichierSeq || !skillFileView.value) return;
    skillFileView.value = {
      path,
      content: contenu !== null ? contenu : "(vide ou illisible)",
      loading: false,
    };
  }
  function closeSkillFile(): void {
    fichierSeq++;
    skillFileView.value = null;
  }

  function onTreeOpenFile(
    payload: { skill?: ResumeSkill | undefined; path?: string | undefined } | null,
  ): void {
    if (!payload || !payload.skill || !payload.path) return;
    const sk = payload.skill;
    const cur = skillDetail.value;
    const same =
      cur && (cur.id || cur.name) === (sk.id || sk.name) && (cur.source || "user") === (sk.source || "user");
    if (!same) void viewSkill(sk);
    void openSkillFile(sk, payload.path);
  }

  const childSkills = (sk: ResumeSkill | null): ResumeSkill[] => enfants(skillsByScope.value, sk);
  const skillBreadcrumb = computed(() => filDAriane(skillsByScope.value, skillDetail.value));
  const skillFileIsMd = computed(() => {
    const f = skillFileView.value;
    return !!(f && f.path && /\.(md|markdown)$/i.test(f.path));
  });

  return {
    openSkillsTab,
    skillsLoading,
    skillsError,
    skillsBusy,
    skillsFilter,
    skillsByScope,
    filteredByScope,
    totalSkillsCount,
    aucunSkillPerso,
    filteredTotalCount,
    skillEditMode,
    skillDetail,
    skillForm,
    isSkillAdmin: isAdmin,
    canEditScope,
    editableScopes,
    scopeLabel,
    loadAllSkills,
    viewSkill,
    startCreate,
    startEdit,
    cancelEdit,
    backToSkillsList,
    saveSkill,
    deleteSkill,
    promoteSkill,
    importSkillZip,
    importSkillFolder,
    importSkillMd,
    skillsImporting,
    showSkillImportMenu,
    importMenuBtn,
    closeSkillImportMenu,
    exportSkillZip,
    skillsDragOver,
    onSkillsDragEnter,
    onSkillsDragOver,
    onSkillsDragLeave,
    onSkillsDrop,
    skillBodyView,
    skillFileIsMd,
    collapsedSkills,
    toggleCollapse,
    skillsTreeByScope,
    selectedNodeKey,
    activeFileNodeKey,
    onTreeOpenFile,
    skillBreadcrumb,
    childSkills,
    skillFileView,
    openSkillFile,
    closeSkillFile,
  };
}

export type SurfaceSkills = ReturnType<typeof creerSkills>;
export type { NoeudSkill };
