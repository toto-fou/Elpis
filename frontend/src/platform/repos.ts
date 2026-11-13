// SPDX-License-Identifier: MIT
/** frontend/src/platform/repos.ts — travaux reportés au repos du navigateur : tâche unique au premier repos, ou file de tranches lancées une à une après plusieurs secondes sans geste ni flux. */

/** Calme exigé avant chaque tranche de fond : ni touche, ni appui, ni molette. */
export const CALME_MS = 5000;

type Tranche = () => unknown;

const file: Tranche[] = [];
let estOccupe: () => boolean = () => false;
let derniereActivite = 0;
let ecoute = false;
let programmee = false;

/** Lance `tache` quand le navigateur est au repos, au plus tard après `delai` ms. */
export function auRepos(tache: () => void, delai = 3000): void {
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(() => tache(), { timeout: delai });
  else setTimeout(tache, Math.min(delai, 1500));
}

/** Ce qui suspend les travaux de fond et les préchargements (un flux en cours, par exemple). */
export function definirOccupation(f: () => boolean): void {
  estOccupe = f;
}

/** Vrai tant que les travaux de fond doivent attendre. */
export function occupe(): boolean {
  return estOccupe();
}

function activite(): void {
  derniereActivite = performance.now();
}

/** Ajoute des tranches de fond, lancées dans l'ordre, une par rappel de repos, après `CALME_MS` sans geste et hors flux. */
export function auReposProlonge(...tranches: Tranche[]): void {
  if (!ecoute) {
    ecoute = true;
    activite();
    for (const t of ["keydown", "pointerdown", "wheel"])
      window.addEventListener(t, activite, { capture: true, passive: true });
  }
  file.push(...tranches);
  programmer(CALME_MS);
}

function programmer(delai: number): void {
  if (programmee || !file.length) return;
  programmee = true;
  setTimeout(() => {
    const reste = CALME_MS - (performance.now() - derniereActivite);
    if (reste > 0 || occupe()) {
      programmee = false;
      programmer(Math.max(reste, 1000));
      return;
    }
    auRepos(() => void executer(), CALME_MS);
  }, delai);
}

// Une tranche par rappel : un geste ou un flux survenu entre-temps la renvoie au prochain calme.
async function executer(): Promise<void> {
  programmee = false;
  if (performance.now() - derniereActivite < CALME_MS || occupe()) {
    programmer(1000);
    return;
  }
  const tranche = file.shift();
  try {
    await tranche?.();
  } catch {
    /* préchargement facultatif */
  }
  programmer(0);
}
