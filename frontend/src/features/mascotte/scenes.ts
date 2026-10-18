// SPDX-License-Identifier: MIT
/** frontend/src/features/mascotte/scenes.ts — scénarios de l'accueil : listes d'actes datés de la mascotte (repos, salut, sieste, vol, souffle, foudre…) et scènes du gang du skin kiki. */

export interface Acte {
  t: number;
  anim?: readonly string[];
  marche?: boolean;
  x?: string | number;
  depuis?: string;
  saut?: number;
  vitesse?: number;
  prend?: boolean;
  repose?: boolean;
  revient?: boolean;
  delaiPrise?: number;
  flanc?: string;
  zzz?: boolean;
  cible?: number;
  charge?: boolean;
  aura?: boolean;
  tonnerre?: boolean;
  residu?: boolean;
  eclat?: boolean;
  vise?: boolean;
  cabre?: number;
  balaye?: boolean;
  fumee?: boolean;
  souffle?: boolean;
  perso?: string | null;
  fondu?: boolean;
  pivot?: boolean;
  degaine?: boolean;
  rengaine?: boolean;
  rebouche?: boolean;
  recolle?: boolean;
  tir?: { cible: number; trou: readonly [number, number] };
  tranche?: { delai?: number };
}

export interface Scenario {
  etiquette?: string;
  quoi?: string;
  tenir?: boolean;
  boucle?: boolean;
  perso?: string | null;
  actes: readonly Acte[];
  sortie?: readonly Acte[];
  sortieVers?: Readonly<Record<string, readonly Acte[]>>;
}

export const SCENARIOS: Record<string, Scenario> = {
  repos: {
    etiquette: "Le repos",
    quoi: "elle reste où elle est ; l'état normal, entre deux événements",
    tenir: true,
    actes: [{ t: 0.0, anim: ["idle"] }],
  },
  salut: {
    etiquette: "Le salut",
    quoi: "elle vient au milieu, salue, saute — à l'ouverture d'un chat",
    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "centre" },
      { t: 2.8, anim: ["wave", "cheer", "bounce"] },
      { t: 4.8, anim: ["jump"], saut: 7 },
      { t: 6.2, anim: ["cheer", "wave", "dance"] },
      { t: 8.2, anim: ["idle"] },
    ],
  },
  reveil: {
    etiquette: "Le réveil",
    quoi: "elle sursaute et se remet debout — au premier geste après la sieste",
    actes: [
      { t: 0.0, anim: ["wake", "bounce", "idle"] },
      { t: 1.6, anim: ["look", "idle"] },
      { t: 3.0, anim: ["idle"] },
    ],
  },
  sieste: {
    etiquette: "La sieste",
    quoi: "elle se range à gauche et dort — cinq minutes sans un geste",

    tenir: true,
    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "gauche" },
      { t: 2.8, anim: ["waiting", "idle"] },
      { t: 4.4, anim: ["sleep"], zzz: true },
    ],
  },
  chantier: {
    etiquette: "Le chantier",
    quoi: "elle se met au travail sous le mot — une génération tourne",

    tenir: true,
    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "sousS" },
      { t: 3.0, anim: ["review", "look", "waiting"] },
      { t: 4.8, anim: ["running", "dance", "bounce"] },
    ],
  },
  foudre: {
    etiquette: "La foudre",
    quoi: "elle s'électrise, et le ciel tombe sur le mot — trois fois",

    actes: [
      { t: 0.0, anim: ["idle"] },

      { t: 0.9, marche: true, x: "centre" },
      { t: 2.6, anim: ["eclair", "waiting", "idle"], charge: true, aura: true },
      { t: 4.0, anim: ["eclair", "cheer", "wave"], tonnerre: true, cible: 1, aura: true },

      { t: 5.1, anim: ["eclair", "cheer", "wave"], tonnerre: true, cible: -1, aura: true },
      { t: 5.9, anim: ["eclair", "cheer", "wave"], tonnerre: true, cible: 0, aura: true },
      { t: 7.0, anim: ["waiting", "idle"], cible: 1, residu: true, aura: true },
      { t: 8.6, anim: ["cheer", "wave", "bounce"] },
      { t: 10.4, anim: ["idle"] },
    ],
  },
  souffle: {
    etiquette: "Le souffle",
    quoi: "il longe le mot et le balaie de flammes, de gauche à droite",

    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.9, marche: true, x: "horsGauche" },
      { t: 1.6, marche: true, x: "souffle", vise: true },

      { t: 3.4, anim: ["feu", "run-right", "idle"], vise: true, cabre: -2 },
      { t: 4.2, anim: ["feu", "run-right", "idle"], vise: true, balaye: true },
      { t: 7.4, anim: ["run-right", "idle"], vise: true, marche: true, x: "droite" },
      { t: 8.8, anim: ["look", "waiting", "idle"], fumee: true },
      { t: 11.0, anim: ["cheer", "wave", "bounce"] },
      { t: 13.0, anim: ["idle"] },
    ],
  },
  pouvoir: {
    etiquette: "Le pouvoir",
    quoi: "elle se campe, charge, et lâche sa capacité — l'éclair, le feu",

    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "centre" },
      { t: 2.6, anim: ["waiting", "look", "idle"] },
      { t: 3.8, anim: ["espoir", "eclair", "feu", "cheer", "wave"], eclat: true },
      { t: 7.4, anim: ["cheer", "wave", "bounce"] },
      { t: 9.4, anim: ["idle"] },
    ],
  },
  vol: {
    etiquette: "Le vol",
    quoi: "elle décroche le S, l'emporte, revient le remettre",
    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "sousS" },
      { t: 3.0, anim: ["look", "idle"] },
      { t: 4.2, anim: ["jump"], saut: 7, prend: true },
      { t: 5.8, marche: true, x: "droite" },
      { t: 8.0, anim: ["look", "waiting", "idle"] },
      { t: 9.6, marche: true, x: "sousS" },
      { t: 11.8, anim: ["jump"], saut: 7, repose: true },
      { t: 13.4, anim: ["cheer", "wave", "bounce"] },
      { t: 15.4, anim: ["idle"] },
    ],
  },
  ronde: {
    etiquette: "La ronde",
    quoi: "elle inspecte le mot lettre par lettre",
    actes: [
      { t: 0.0, anim: ["idle"] },
      { t: 0.8, marche: true, x: "sousE" },
      { t: 2.6, anim: ["look", "idle"] },
      { t: 4.2, marche: true, x: "sousP" },
      { t: 5.8, anim: ["look", "idle"] },
      { t: 7.4, anim: ["jump"], saut: 7 },
      { t: 8.8, marche: true, x: "sousS" },
      { t: 10.4, anim: ["waiting", "idle"] },
      { t: 12.2, anim: ["dance", "bounce", "cheer"] },
      { t: 14.4, anim: ["idle"] },
    ],
  },
};

export const SCENES_GANG: Record<string, Scenario> = {
  arrivee: {
    etiquette: "L'arrivée",
    quoi: "le gang vient se poser sous le titre et salue",
    actes: [
      { t: 0.0, marche: true, x: "centre" },
      { t: 3.6, anim: ["salut", "idle"] },
      { t: 4.9, anim: ["idle"] },
    ],
  },

  attente: {
    etiquette: "L'attente",
    quoi: "le gang se retourne face à nous et patiente, Kiki fume",
    tenir: true,

    actes: [
      { t: 0.0, marche: true, x: "centre", vitesse: 32 },

      { t: 2.4, anim: ["tourne", "idle"], perso: "kiki_face", fondu: true },
      { t: 3.6, anim: ["attente", "idle"], perso: "kiki_face" },
    ],
    sortieVers: {
      fusillade: [
        { t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
        { t: 1.05, anim: ["idle"], fondu: true },
        { t: 1.5, anim: ["idle"] },
      ],
      patrouille: [
        { t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
        { t: 1.05, anim: ["idle"], fondu: true },
        { t: 1.5, anim: ["idle"] },
      ],
      arrivee: [
        { t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
        { t: 1.05, anim: ["idle"], fondu: true },
        { t: 1.5, anim: ["idle"] },
      ],
    },
    sortie: [
      { t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
      { t: 1.05, anim: ["idle"], fondu: true },
      { t: 1.4, marche: true, x: "horsDroite" },
      { t: 4.8, anim: ["idle"] },
    ],
  },

  fusillade: {
    etiquette: "La fusillade",
    quoi: "Kiki dégaine et troue les lettres, puis tout le monde se repose",
    actes: [
      { t: 0.0, marche: true, x: "posteTir", vitesse: 32 },
      { t: 2.2, anim: ["idle"] },
      { t: 2.4, anim: ["degaine", "idle"], degaine: true },
      { t: 3.0, anim: ["vise", "idle"] },
      { t: 3.3, anim: ["tir", "vise", "idle"], tir: { cible: 0, trou: [1, 7] } },
      { t: 3.9, anim: ["tir", "vise", "idle"], tir: { cible: 1, trou: [5, 1] } },
      { t: 4.4, anim: ["tir", "vise", "idle"], tir: { cible: 2, trou: [1, 11] } },
      { t: 5.0, anim: ["tir", "vise", "idle"], tir: { cible: 3, trou: [5, 8] } },
      { t: 5.4, anim: ["vise", "idle"] },
      { t: 6.2, anim: ["rengaine", "idle"], rengaine: true },
      { t: 6.8, anim: ["idle"] },
      { t: 8.2, anim: ["idle"], rebouche: true },
      { t: 9.6, anim: ["idle"] },
    ],
  },

  coupe: {
    etiquette: "La coupe",
    quoi: "Kiki guerrière tranche une lettre en deux et repart",
    perso: "kiki_guerriere",
    actes: [
      { t: 0.0, anim: ["idle"], x: "horsGauche", depuis: "horsGauche" },
      { t: 0.3, marche: true, x: "posteCoupe" },
      { t: 3.6, anim: ["idle"] },
      { t: 4.4, anim: ["attaque", "idle"], tranche: { delai: 0.3 } },
      { t: 5.4, anim: ["victoire", "idle"] },
      { t: 7.4, anim: ["idle"] },
      { t: 7.9, marche: true, x: "horsDroite" },
      { t: 11.4, anim: ["idle"], recolle: true },
      { t: 12.6, anim: ["idle"] },
    ],
    sortie: [
      { t: 0.0, marche: true, x: "horsDroite" },
      { t: 3.0, anim: ["idle"] },
    ],
  },

  dodo: {
    etiquette: "Le dodo",
    quoi: "Kiki en grenouillère vient s'endormir au pied du mot",
    perso: "kiki_dodo",
    tenir: true,
    actes: [
      { t: 0.0, anim: ["idle"], x: "horsGauche", depuis: "horsGauche" },
      { t: 0.4, marche: true, x: "gauche" },
      { t: 4.4, anim: ["endort", "idle"] },
      { t: 6.6, anim: ["dort", "sleep", "idle"] },
    ],
    sortie: [
      { t: 0.0, anim: ["reveille", "idle"] },
      { t: 1.8, anim: ["idle"] },
      { t: 2.3, marche: true, x: "horsDroite" },
      { t: 6.0, anim: ["idle"] },
    ],
  },

  patrouille: {
    etiquette: "La patrouille",
    quoi: "le gang fait des allers sous le mot — une génération tourne",
    boucle: true,
    tenir: true,
    actes: [
      { t: 0.0, marche: true, x: "horsDroite" },
      { t: 8.0, anim: ["idle"] },
      { t: 8.6, anim: ["idle"] },
    ],
  },
};
Object.assign(SCENARIOS, SCENES_GANG);

export const SCENARIOS_TIRABLES = [
  "vol",
  "salut",
  "sieste",
  "chantier",
  "ronde",
  "pouvoir",
  "souffle",
  "foudre",
];
