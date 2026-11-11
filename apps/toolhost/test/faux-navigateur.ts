// SPDX-License-Identifier: MIT
/** apps/toolhost/test/faux-navigateur.ts — service navigateur factice (server.js) : réponses déterministes par route et par page courante, requêtes reçues relevées telles quelles. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as dormir } from "node:timers/promises";

import type { Dict } from "@elpis/commun";

export interface RequeteNavigateur {
  readonly methode: string;
  readonly chemin: string;
  readonly requete: string;
  readonly corps: string;
}

export const SITE = "http://93.184.216.34";
export const SESSION = "sessAAAA1111";

export type Reponse = [number, Dict | string];

export class FauxNavigateur {
  readonly vues: RequeteNavigateur[] = [];
  /** Réponses imposées aux prochaines requêtes d'une route (`POST /wait_for_dynamic`), dans l'ordre. */
  readonly imposees = new Map<string, Reponse[]>();
  private courante = "";
  private attentes = 0;

  private readonly serveur: Server;

  private constructor(serveur: Server) {
    this.serveur = serveur;
  }

  static async demarrer(): Promise<FauxNavigateur> {
    let faux: FauxNavigateur | null = null;
    const serveur = createServer((req, res) => {
      const morceaux: Buffer[] = [];
      req.on("data", (m: Buffer) => morceaux.push(m));
      req.on("end", () => {
        void (faux as FauxNavigateur)
          .servir(req.method ?? "GET", req.url ?? "/", Buffer.concat(morceaux).toString())
          .then(([statut, corps]) => {
            const texte = typeof corps === "string" ? corps : JSON.stringify(corps);
            res.writeHead(statut, {
              "content-type": typeof corps === "string" ? "text/plain" : "application/json",
            });
            res.end(texte);
          });
      });
    });
    faux = new FauxNavigateur(serveur);
    await new Promise<void>((fin) => serveur.listen(0, "127.0.0.1", () => fin()));
    return faux;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
  }

  /** Page courante et requêtes relevées remises à zéro (un passage par service comparé). */
  reinitialiser(): void {
    this.vues.length = 0;
    this.imposees.clear();
    this.courante = "";
    this.attentes = 0;
  }

  async arreter(): Promise<void> {
    this.serveur.closeAllConnections();
    await new Promise<void>((fin) => this.serveur.close(() => fin()));
  }

  private async servir(methode: string, brut: string, texte: string): Promise<Reponse> {
    const i = brut.indexOf("?");
    const chemin = i < 0 ? brut : brut.slice(0, i);
    const requete = i < 0 ? "" : brut.slice(i + 1);
    this.vues.push({ methode, chemin, requete, corps: texte });
    const p = new URLSearchParams(requete);
    let c: Dict;
    try {
      c = texte ? (JSON.parse(texte) as Dict) : {};
    } catch {
      return [400, { error: "bad json" }];
    }
    if (!(methode === "GET" ? p.get("owner") : c["owner"])) return [403, { error: "owner required" }];
    const imposee = this.imposees.get(`${methode} ${chemin}`)?.shift();
    return imposee ?? this.repondre(methode, chemin, p, c);
  }

  private async repondre(methode: string, chemin: string, p: URLSearchParams, c: Dict): Promise<Reponse> {
    const route = `${methode} ${chemin}`;
    if (route === "POST /start") {
      this.courante = String(c["url"]);
      return [200, { ok: true, session_id: SESSION, url: this.courante, reused: false, tab_index: 0 }];
    }
    if (route === "GET /smart_inspect")
      return [
        200,
        {
          url: this.courante,
          title: "Boutique",
          elements: [
            { idx: 0, type: "link", role: "link", name: "Produits" },
            { idx: 1, type: "button", role: "button", name: "Valider" },
          ],
          screenshot_step: 2,
          level: p.get("level"),
        },
      ];
    if (route === "POST /action") {
      if (c["type"] === "goto") {
        this.courante = String(c["url"]);
        return [200, { ok: true, url: this.courante }];
      }
      if (c["type"] === "back") {
        this.courante = `${SITE}/`;
        return [200, { ok: true }];
      }
      if (c["by_text"] === "Casse") return [500, { error: "element not found: Casse" }];
      if (c["by_name"] === "Produits") {
        this.courante = `${SITE}/produits`;
        return [
          200,
          {
            ok: true,
            element_role: "link",
            element_name: "Produits",
            ancestors: [{ role: "navigation", name: "Menu" }, { tag: "header" }],
          },
        ];
      }
      return [200, { ok: true, type: c["type"], region: "main" }];
    }
    if (route === "POST /wait_for_dynamic") {
      if (c["selector"] === "#jamais") {
        await dormir(Number(c["timeout"]) + 50);
        return [408, { status: "timeout", via: "selector", polled_value: { count: 1, visible: true } }];
      }
      this.attentes++;
      if (this.attentes % 2 === 1)
        return [
          408,
          { status: "pending", baseline: { count: 3 }, via: "locator", polled_value: { count: 3 } },
        ];
      return [200, { status: "met", via: "locator", polled_value: { count: 0 }, text: "fini", extra: 1 }];
    }
    if (route === "POST /evaluate")
      return [
        200,
        c["script"] === "grand"
          ? { result: "x".repeat(150) }
          : c["script"] === "liste"
            ? { result: Array.from({ length: 60 }, (_, k) => k) }
            : { result: 42 },
      ];
    if (route === "GET /sessions")
      return [
        200,
        {
          sessions: [
            { session_id: SESSION, url: `${SITE}/PRODUITS`, origin: SITE, owner: "bob" },
            { session_id: "sessBBBB2222", url: "https://autre.example/", origin: null, owner: "alice" },
          ],
        },
      ];
    if (route === "GET /recorder/dump")
      return [
        404,
        { code: "no_recording", error: "Aucun enregistrement", fix: "pw_recorder(action='start')" },
      ];
    if (route === "POST /mock/clear") return [410, {}];
    if (route === "POST /mock/remove") return [500, { error: "boom" }];
    if (route === "POST /visual" && c["name"] === "casse") return [503, "service indisponible"];
    if (route === "POST /screenshot" || route === "POST /element_screenshot")
      return [200, { screenshot: `shot_${SESSION}_3.png`, screenshot_step: 3, elements: [] }];
    return [200, { ok: true, endpoint: chemin }];
  }
}
