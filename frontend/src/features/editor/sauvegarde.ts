// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/sauvegarde.ts — sauvegardes de l'éditeur : retard par panneau lié au fichier d'origine, une écriture en vol par fichier, jamais d'écrasement par une version plus ancienne. */

export interface Instantane {
  readonly texte: string;
  readonly version: number;
}

/** `silencieux` : enregistrement automatique (une version déjà écrite est sautée) ; `force` : sans précondition disque. */
export interface OptionsSauvegarde {
  readonly silencieux: boolean;
  readonly force: boolean;
  readonly source?: string | undefined;
}

export interface DepsSauvegarde {
  lire(chemin: string): Instantane | null;
  ecrire(chemin: string, texte: string, options: OptionsSauvegarde): Promise<boolean>;
  enregistre(chemin: string, version: number): void;
  planifier?: (rappel: () => void, delaiMs: number) => unknown;
  annuler?: (jeton: unknown) => void;
  /** Échéance d'un retard : par défaut `sauvegarder(chemin)` ; l'éditeur y repasse par ses gardes (onglet modifié, lecture seule). */
  echeance?: (chemin: string) => Promise<unknown>;
}

const AUTO: OptionsSauvegarde = { silencieux: true, force: false };

export type IssueSauvegarde = "enregistre" | "a-jour" | "absent" | "echec";

interface Retard {
  readonly chemin: string;
  readonly jeton: unknown;
}

export class ServiceSauvegarde {
  private readonly enVol = new Map<string, Promise<IssueSauvegarde>>();
  private readonly enFile = new Map<
    string,
    { promesse: Promise<IssueSauvegarde>; options: OptionsSauvegarde }
  >();
  private readonly versionEcrite = new Map<string, number>();
  private readonly retards = new Map<string, Retard>();

  private readonly deps: DepsSauvegarde;

  constructor(deps: DepsSauvegarde) {
    this.deps = deps;
  }

  /** Programme (ou reprogramme) la sauvegarde retardée d'un panneau ; le chemin est figé à l'appel. */
  planifier(panneau: string, chemin: string, delaiMs: number): void {
    this.annulerRetard(panneau);
    if (delaiMs <= 0) return;
    const planifier = this.deps.planifier ?? ((r: () => void, d: number) => setTimeout(r, d));
    const jeton = planifier(() => {
      this.retards.delete(panneau);
      void this.echeance(chemin);
    }, delaiMs);
    this.retards.set(panneau, { chemin, jeton });
  }

  /** Déclenche tout de suite la sauvegarde retardée d'un panneau (changement d'onglet) ; rien si aucune n'attend. */
  vider(panneau: string): Promise<unknown> | null {
    const retard = this.retards.get(panneau);
    if (!retard) return null;
    this.annulerRetard(panneau);
    return this.echeance(retard.chemin);
  }

  private echeance(chemin: string): Promise<unknown> {
    return this.deps.echeance ? this.deps.echeance(chemin).catch(() => undefined) : this.sauvegarder(chemin);
  }

  enCours(chemin: string): boolean {
    return this.enVol.has(chemin);
  }

  enVolPour(chemin: string): Promise<IssueSauvegarde> | null {
    return this.enVol.get(chemin) ?? null;
  }

  annulerRetard(panneau: string): void {
    const retard = this.retards.get(panneau);
    if (!retard) return;
    this.retards.delete(panneau);
    (this.deps.annuler ?? ((j: unknown) => clearTimeout(j as ReturnType<typeof setTimeout>)))(retard.jeton);
  }

  /** Annule tous les retards (libération de l'éditeur, déconnexion). */
  annulerRetards(): void {
    for (const panneau of [...this.retards.keys()]) this.annulerRetard(panneau);
  }

  cheminRetarde(panneau: string): string | null {
    return this.retards.get(panneau)?.chemin ?? null;
  }

  /** Une écriture en vol par fichier ; les demandes suivantes se fondent en une reprise qui lit le contenu le plus récent. */
  sauvegarder(chemin: string, options: OptionsSauvegarde = AUTO): Promise<IssueSauvegarde> {
    const vol = this.enVol.get(chemin);
    if (!vol) return this.lancer(chemin, options);
    const file = this.enFile.get(chemin);
    if (file) {
      file.options = {
        ...file.options,
        silencieux: file.options.silencieux && options.silencieux,
        force: file.options.force || options.force,
      };
      return file.promesse;
    }
    const entree = { options, promesse: Promise.resolve<IssueSauvegarde>("absent") };
    entree.promesse = vol.then(
      () => this.reprendre(chemin),
      () => this.reprendre(chemin),
    );
    this.enFile.set(chemin, entree);
    return entree.promesse;
  }

  private reprendre(chemin: string): Promise<IssueSauvegarde> {
    const options = this.enFile.get(chemin)?.options ?? AUTO;
    this.enFile.delete(chemin);
    return this.lancer(chemin, options);
  }

  private lancer(chemin: string, options: OptionsSauvegarde): Promise<IssueSauvegarde> {
    const instantane = this.deps.lire(chemin);
    if (!instantane) return Promise.resolve("absent");
    const ecrite = this.versionEcrite.get(chemin);
    if (options.silencieux && !options.force && ecrite !== undefined && instantane.version <= ecrite)
      return Promise.resolve("a-jour");
    const vol = this.ecrire(chemin, instantane, options).finally(() => {
      if (this.enVol.get(chemin) === vol) this.enVol.delete(chemin);
    });
    this.enVol.set(chemin, vol);
    return vol;
  }

  private async ecrire(
    chemin: string,
    instantane: Instantane,
    options: OptionsSauvegarde,
  ): Promise<IssueSauvegarde> {
    let ok: boolean;
    try {
      ok = await this.deps.ecrire(chemin, instantane.texte, options);
    } catch {
      ok = false;
    }
    if (!ok) return "echec";
    const ecrite = this.versionEcrite.get(chemin);
    if (ecrite === undefined || instantane.version > ecrite)
      this.versionEcrite.set(chemin, instantane.version);
    this.deps.enregistre(chemin, instantane.version);
    return "enregistre";
  }

  /** Oublie l'état d'un fichier fermé, renommé ou rechargé depuis le disque. */
  oublier(chemin: string): void {
    this.versionEcrite.delete(chemin);
    for (const [panneau, retard] of this.retards) if (retard.chemin === chemin) this.annulerRetard(panneau);
  }
}
