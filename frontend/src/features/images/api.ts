// SPDX-License-Identifier: MIT
/** frontend/src/features/images/api.ts — accès REST aux images (`/api/image/status`, `/api/images*`, préférences du compte), réponses validées par les schémas C2. */
import { schemaReponseEtatImages, schemaReponseGalerieImages } from "@elpis/contracts";
import type { ImageGeneree } from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";
import type { PreferencesImages } from "./formats";

/** État du moteur, vu en champs optionnels : seuls `ready` et `available` sont garantis. */
export interface StatutMoteurImages {
  ready: boolean;
  available: boolean;
  tool_enabled?: boolean;
  provider?: string;
  model?: string;
  ratios?: string[];
  sides?: number[];
  default_side?: number;
  max_side?: number;
  step?: number;
  max_n?: number;
  size_policy?: string;
  sizes?: unknown[];
  features?: { seed?: boolean; negative?: boolean; steps?: boolean; strength?: boolean; edit?: boolean };
  enhance_enabled?: boolean;
  keep_per_user?: number;
  prefs?: PreferencesImages;
  stored?: number;
}

export interface PageGalerie {
  items: ImageGeneree[];
  next_before: number | null;
  total: number;
  keep: number;
}

export type ResultatSuppression = "ok" | "absente" | "echec";

export interface ApiImages {
  statut(): Promise<StatutMoteurImages | null>;
  galerie(params: {
    limite: number;
    avant?: number | null;
    chat?: string | null;
  }): Promise<PageGalerie | null>;
  supprimer(id: string): Promise<ResultatSuppression>;
  enregistrerPreferences(prefs: PreferencesImages): Promise<void>;
}

export function creerApiImages(http: ClientHttp): ApiImages {
  return {
    async statut() {
      const r = await http.requete("/api/image/status", {}, { schema: schemaReponseEtatImages });
      return r.type === "ok" ? (r.valeur as StatutMoteurImages) : null;
    },
    async galerie({ limite, avant, chat }) {
      const qs = new URLSearchParams({ limit: String(limite) });
      if (avant !== null && avant !== undefined) qs.set("before", String(avant));
      if (chat) qs.set("chat_id", chat);
      const r = await http.requete(
        `/api/images?${qs.toString()}`,
        {},
        { schema: schemaReponseGalerieImages },
      );
      return r.type === "ok" ? r.valeur : null;
    },
    async supprimer(id) {
      const r = await http.requete(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.type === "ok") return "ok";
      return r.type === "requete" && r.statut === 404 ? "absente" : "echec";
    },
    async enregistrerPreferences(prefs) {
      await http.requete("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_prefs: prefs }),
      });
    },
  };
}
