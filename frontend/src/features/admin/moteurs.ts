// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/moteurs.ts — type de moteur déclaré dans le formulaire (alias de `llama.engine`) et ce que la console en dit. */

export type TypeMoteurConsole = "llamacpp" | "vllm" | "sglang" | "generic";

const ALIAS: Readonly<Record<string, TypeMoteurConsole>> = {
  "": "llamacpp",
  llamacpp: "llamacpp",
  "llama.cpp": "llamacpp",
  "llama-cpp": "llamacpp",
  llama_cpp: "llamacpp",
  llama: "llamacpp",
  vllm: "vllm",
  sglang: "sglang",
};

/** Même normalisation que le serveur (`typeMoteurLlama`) : alias connus, sinon générique. */
export function typeDeclare(brut: unknown): TypeMoteurConsole {
  const cle = typeof brut === "string" ? brut.trim().toLowerCase() : "";
  return ALIAS[cle] ?? "generic";
}

export interface ProfilConsole {
  resume: string;
  port: number;
  /** Les requêtes passent par la file d'Elpis (créneaux, exclusivité de modèle). */
  file: boolean;
  concurrence: string;
}

const PROFILS: Readonly<Record<TypeMoteurConsole, ProfilConsole>> = {
  llamacpp: {
    resume: "Slots, /props, chargement à la demande en mode routeur, tokenisation exacte.",
    port: 8080,
    file: true,
    concurrence: "",
  },
  vllm: {
    resume: "Modèle choisi au lancement ; métriques, tokenisation exacte, cache de préfixe, lots continus.",
    port: 8000,
    file: false,
    concurrence:
      "Gérée par vLLM (lots continus) : les requêtes partent en parallèle, plafond réglé par --max-num-seqs.",
  },
  sglang: {
    resume: "Modèle choisi au lancement ; métriques, tokenisation exacte, cache radix, lots continus.",
    port: 30000,
    file: false,
    concurrence:
      "Gérée par SGLang (lots continus) : les requêtes partent en parallèle, plafond réglé par --max-running-requests.",
  },
  generic: {
    resume: "API OpenAI standard seulement : ni métriques, ni tokenisation exacte, ni chargement.",
    port: 8000,
    file: false,
    concurrence: "Les requêtes partent en parallèle ; le serveur décide de leur ordre.",
  },
};

export function profilConsole(type: TypeMoteurConsole): ProfilConsole {
  return PROFILS[type];
}
