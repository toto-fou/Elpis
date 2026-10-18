// SPDX-License-Identifier: MIT
/** frontend/src/features/skills/arbre.ts — fonctions pures de la page Skills : filtre, arbre par portée (domaines, sous-skills, fichiers), frontmatter, slug. */
import type { ResumeSkill } from "@elpis/contracts";

export type Portee = "global" | "learned" | "user";
export const PORTEES: readonly Portee[] = ["global", "learned", "user"];

export type InventaireSkills = Record<Portee, ResumeSkill[]>;

export interface NoeudSkill {
  key: string;
  kind: "domain" | "skill" | "file";
  label: string;
  skill?: ResumeSkill;
  path?: string;
  children: NoeudSkill[];
  childSkillCount?: number;
}

export type ArbreParPortee = Record<Portee, NoeudSkill[]>;

export function inventaireVide(): InventaireSkills {
  return { user: [], learned: [], global: [] };
}

/** Groupes filtrés par le texte saisi (nom, description, domaine, tags), ordre de la source conservé. */
export function filtrerInventaire(inv: InventaireSkills, filtre: string): InventaireSkills {
  const q = filtre.trim().toLowerCase();
  const sortie = inventaireVide();
  for (const scope of PORTEES) {
    const liste = inv[scope] || [];
    sortie[scope] = !q
      ? liste
      : liste.filter((s) => {
          const meule =
            `${s.name || ""} ${s.description || ""} ${s.domain || ""} ${(s.tags || []).join(" ")}`.toLowerCase();
          return meule.indexOf(q) !== -1;
        });
  }
  return sortie;
}

const idDe = (s: ResumeSkill): string => s.id || s.name;

/** Arbre réel de chaque portée : sous-skills sous leur parent, fichiers groupés, domaine en dossier seulement s'il n'est pas redondant. */
export function construireArbres(filtre: InventaireSkills): ArbreParPortee {
  const sortie: ArbreParPortee = { user: [], learned: [], global: [] };
  for (const scope of PORTEES) {
    const liste = filtre[scope] || [];
    const noeuds: Record<string, NoeudSkill> = {};
    for (const s of liste) {
      noeuds[idDe(s)] = {
        key: `${scope}:${idDe(s)}`,
        kind: "skill",
        label: s.name,
        skill: s,
        children: [],
        childSkillCount: 0,
      };
    }
    const racines: NoeudSkill[] = [];
    for (const s of liste) {
      const noeud = noeuds[idDe(s)] as NoeudSkill;
      const parent = s.parent_id ? noeuds[s.parent_id] : undefined;
      (parent ? parent.children : racines).push(noeud);
      if (parent) parent.childSkillCount = (parent.childSkillCount ?? 0) + 1;
    }
    for (const s of liste) {
      const noeud = noeuds[idDe(s)] as NoeudSkill;
      for (const f of s.files || []) {
        noeud.children.push({
          key: `${noeud.key}::${f}`,
          kind: "file",
          label: f,
          path: f,
          skill: s,
          children: [],
        });
      }
    }
    const parDomaine: Record<string, NoeudSkill> = {};
    const haut: NoeudSkill[] = [];
    for (const r of racines) {
      const dom = (r.skill?.domain || "").trim();
      if (!dom) {
        haut.push(r);
        continue;
      }
      let dossier = parDomaine[dom];
      if (!dossier) {
        dossier = { key: `${scope}:dom:${dom}`, kind: "domain", label: dom, children: [] };
        parDomaine[dom] = dossier;
        haut.push(dossier);
      }
      dossier.children.push(r);
    }
    for (let i = 0; i < haut.length; i++) {
      const n = haut[i] as NoeudSkill;
      const seul = n.children[0];
      if (
        n.kind === "domain" &&
        n.children.length === 1 &&
        seul &&
        seul.kind === "skill" &&
        seul.skill?.name === n.label
      ) {
        haut[i] = seul;
      }
    }
    sortie[scope] = haut;
  }
  return sortie;
}

/** Clés des nœuds à enfants, pour replier l'arbre à l'ouverture. */
export function clesDepliables(noeuds: readonly NoeudSkill[], acc = new Set<string>()): Set<string> {
  for (const n of noeuds) {
    if (n.children.length > 0) {
      acc.add(n.key);
      clesDepliables(n.children, acc);
    }
  }
  return acc;
}

/** Retire un bloc frontmatter en tête : le détail affiche déjà description, tags et domaine. */
export function retirerFrontmatter(t: string | null | undefined): string {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(t || "");
  return m ? (t || "").slice(m[0].length) : t || "";
}

/** Miroir de `slugify_name` du serveur : accents retirés, minuscules, tirets, [a-z0-9_-]. */
export function slugClient(s: unknown): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export function libellePortee(scope: string): string {
  return scope === "user" ? "perso" : scope === "learned" ? "learned" : "global";
}

export function descendants(inv: InventaireSkills, scope: Portee, id: string): ResumeSkill[] {
  return (inv[scope] || []).filter((s) => idDe(s).indexOf(`${id}/`) === 0);
}

export function enfants(inv: InventaireSkills, sk: ResumeSkill | null): ResumeSkill[] {
  if (!sk) return [];
  const id = idDe(sk);
  const scope = (sk.source || "user") as Portee;
  return (inv[scope] || []).filter((s) => s.parent_id === id);
}

export function filDAriane(inv: InventaireSkills, d: ResumeSkill | null): ResumeSkill[] {
  if (!d || !d.parent_id) return [];
  const parId: Record<string, ResumeSkill> = {};
  for (const s of inv[(d.source || "user") as Portee] || []) parId[idDe(s)] = s;
  const chaine: ResumeSkill[] = [];
  let p: string | null = d.parent_id;
  while (p && parId[p]) {
    const s = parId[p] as ResumeSkill;
    chaine.unshift(s);
    p = s.parent_id;
  }
  return chaine;
}
