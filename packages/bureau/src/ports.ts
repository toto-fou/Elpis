// SPDX-License-Identifier: MIT
/** packages/bureau/src/ports.ts — dépendances du bureau fournies par l'application : primitives de l'agent (desktop_tools), mémoire des ancres, images, erreur d'outil, agent HTTP. */
import type { Dict } from "@elpis/commun";

/** Ancre épinglée pour une requête (`lookup_action_anchor`). */
export type AncreEpinglee = { auto_id?: unknown; role?: unknown; center?: unknown };

/** Ancres de ciblage (`ancres.ts`) : best-effort, une panne n'empêche jamais la résolution. */
export interface PortAncres {
  lookupActionAnchor(scope: string, query: string): Promise<AncreEpinglee | null>;
  recordActionAnchor(
    scope: string,
    query: string,
    autoId: string,
    options: { role: string; center: unknown },
  ): Promise<void>;
}

let ancres: PortAncres | null = null;

export function installerAncres(port: PortAncres | null): void {
  ancres = port;
}

export function portAncres(): PortAncres | null {
  return ancres;
}

export type OptionsObservation = {
  prompt: string;
  use_vision: boolean;
  use_tree: boolean;
  persist_frame?: boolean;
};
export type OptionsLancement = { app: string; timeout_ms: number };
export type OptionsAttenteFenetre = {
  title_re: string;
  auto_id: unknown;
  ready: boolean;
  timeout_ms: number;
};

/** Primitives `*_core` de desktop_tools (arguments nommés comme en Python) ; `probeTree` et `observe` inscrivent leurs éléments dans session.ts. */
export interface PrimitivesBureau {
  grab(username: string, target: string): Promise<unknown>;
  probeTree(username: string, target: string): Promise<unknown>;
  observe(username: string, target: string, options: OptionsObservation): Promise<unknown>;
  act(username: string, target: string, kw: Dict): Promise<unknown>;
  readText(username: string, target: string, options: { element_id?: string }): Promise<unknown>;
  launch(username: string, target: string, options: OptionsLancement): Promise<unknown>;
  waitWindow(username: string, target: string, options: OptionsAttenteFenetre): Promise<unknown>;
}

let primitives: PrimitivesBureau | null = null;

export function installerPrimitivesBureau(port: PrimitivesBureau | null): void {
  primitives = port;
}

export function primitivesBureau(): PrimitivesBureau {
  if (primitives === null) throw new Error("primitives du bureau non installées (installerPrimitivesBureau)");
  return primitives;
}

/** Port requis mais non installé : levé, jamais avalé par les replis best-effort (`except Exception` de Python). */
export class PortNonInstalle extends Error {}

/** Pixels des captures (Pillow en Python), fournis par l'application. */
export interface ImagesBureau {
  dimensions(octets: Uint8Array): readonly [number, number] | null;
  signature(octets: Uint8Array): Promise<string>;
  recadrer(octets: Uint8Array, x1: number, y1: number, x2: number, y2: number): Promise<Uint8Array>;
  reduireLargeur(
    png: Uint8Array,
    largeurMax: number,
    largeurNative: number,
  ): Promise<{ octets: Uint8Array; largeur: number }>;
}

export type OptionsErreur = { fix?: string; nextAction?: string; retryable?: boolean } & Dict;

/** `_toolkit.err` : `{ok: false, error, message}` + `fix`, `next_action`, `retryable` et le contexte. */
export type ErreurOutil = (code: string, message: string, o?: OptionsErreur) => Dict;

/** `_toolkit.err` sans le catalogue de libellés (`errors.<code>` de context_config), que l'application installe. */
function errSansCatalogue(code: string, message: string, o: OptionsErreur = {}): Dict {
  const { fix, nextAction, retryable, ...contexte } = o;
  const e: Dict = { ok: false, error: code, message };
  if (fix) e["fix"] = fix;
  if (nextAction) e["next_action"] = nextAction;
  if (retryable) e["retryable"] = true;
  return Object.assign(e, contexte);
}

/** Services des outils `desktop_*` ; `lireSandbox` lit dans la sandbox du compte (garde de l'Espace, sans suivre de lien), en UTF-8 strict, borné à `maxOctets` ; un échec rend le repli de Python. */
export interface ServicesOutilsBureau {
  idCompte(username: string): Promise<number | null>;
  lireSandbox(username: string, chemin: string, maxOctets: number): Promise<string>;
  notifier(compte: { user_id: number; username: string }, titre: string, corps: string): Promise<void>;
}

export type SocleBureau = {
  images: ImagesBureau | null;
  err: ErreurOutil;
  agentUtilisateur: string;
  services: ServicesOutilsBureau | null;
};

const socle: SocleBureau = {
  images: null,
  err: errSansCatalogue,
  agentUtilisateur: "elpis-core",
  services: null,
};

/** Pose les dépendances fixes de l'application (images, erreur d'outil, `User-Agent`, services des outils) ; les absentes gardent leur défaut. */
export function installerSocleBureau(s: Partial<SocleBureau>): void {
  Object.assign(socle, s);
}

export function imagesBureau(): ImagesBureau {
  if (socle.images === null)
    throw new PortNonInstalle("images du bureau non installées (installerSocleBureau)");
  return socle.images;
}

export function err(code: string, message: string, o: OptionsErreur = {}): Dict {
  return socle.err(code, message, o);
}

export function agentUtilisateur(): string {
  return socle.agentUtilisateur;
}

export function servicesOutilsBureau(): ServicesOutilsBureau | null {
  return socle.services;
}
