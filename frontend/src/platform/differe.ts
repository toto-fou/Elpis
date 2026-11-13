// SPDX-License-Identifier: MIT
/** frontend/src/platform/differe.ts — morceaux du build chargés à la demande : import partagé par le préchargement et l'ouverture, nouvel essai après une coupure, rechargement quand une mise à jour a retiré le morceau. */

const CLE_RECHARGEMENT = "elpis:rechargement-version";
const ECART_RECHARGEMENTS_MS = 60_000;

/** Importe une fois (appels concurrents partagés) ; un échec purge la mémoïsation pour permettre un nouvel essai. */
export function chargeurUnique<T>(importer: () => Promise<T>): () => Promise<T> {
  let enCours: Promise<T> | null = null;
  return () =>
    (enCours ??= importer().catch((err: unknown) => {
      enCours = null;
      throw err;
    }));
}

/** Vrai si la page que sert le serveur n'annonce plus les modules de celle-ci : l'application a été mise à jour. */
export async function versionRemplacee(): Promise<boolean> {
  const modules = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) =>
    new URL(s.src, location.href).pathname.split("/").pop(),
  );
  if (!modules.length) return false;
  try {
    const r = await fetch(location.pathname + location.search, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!r.ok) return false;
    const html = await r.text();
    return modules.some((m) => !!m && !html.includes(m));
  } catch {
    return false;
  }
}

/** Recharge la page, au plus une fois par minute (deux serveurs de versions différentes ne la font pas boucler) ; vrai si elle recharge. */
export function rechargerPage(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(CLE_RECHARGEMENT) || 0) < ECART_RECHARGEMENTS_MS)
      return false;
    sessionStorage.setItem(CLE_RECHARGEMENT, String(Date.now()));
  } catch {
    /* stockage refusé : la page rechargée annonce de toute façon les modules du serveur */
  }
  location.reload();
  return true;
}

export interface RappelsMorceaux<K extends string> {
  /** Le morceau est là : l'appelant peut le monter. */
  charge(k: K): void;
  /** Coupure pendant une ouverture demandée par l'utilisateur. */
  echec(k: K, reessayer: () => void): void;
}

/** Morceaux nommés : préchargement silencieux ; ouverture demandée qui recharge la page après une mise à jour ou signale une coupure. */
export function creerMorceaux<I extends Record<string, () => Promise<unknown>>>(
  importeurs: I,
  rappels: RappelsMorceaux<Extract<keyof I, string>>,
) {
  type K = Extract<keyof I, string>;
  const charger = {} as { [C in K]: I[C] };
  for (const [k, importer] of Object.entries(importeurs)) charger[k as K] = chargeurUnique(importer) as I[K];
  const charges = new Set<K>();
  const enDemande = new Set<K>();
  const marquer = (k: K): void => {
    charges.add(k);
    rappels.charge(k);
  };
  const precharger = (k: K): Promise<void> => charger[k]().then(() => marquer(k));
  async function demander(k: K): Promise<void> {
    if (charges.has(k) || enDemande.has(k)) return;
    enDemande.add(k);
    try {
      await charger[k]();
      marquer(k);
    } catch {
      if (!((await versionRemplacee()) && rechargerPage())) rappels.echec(k, () => void demander(k));
    } finally {
      enDemande.delete(k);
    }
  }
  return { charger, precharger, demander };
}
