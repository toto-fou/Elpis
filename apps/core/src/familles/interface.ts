// SPDX-License-Identifier: MIT
/** apps/core/src/familles/interface.ts — pages (`/`, `/admin`), fichiers statiques, configuration publique, logo d'accueil et logo de l'application. */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { HttpError, quotePy, veritePy } from "@elpis/commun";
import { config, configView, httpsEnabled, httpsPorts } from "@elpis/config";
import { urlsafeB64Decode } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  CHEMIN_APERCU_CODE,
  PAGE_APERCU_CODE,
  POLITIQUE_APERCU_CODE,
  Pages,
  enteteCsp,
  modeCspConfigure,
} from "../interface/pages";
import { adresseEcoute, hotePourConfig } from "../ecoute";
import { servirStatique } from "../interface/statiques";
import { resoudreUrlPublique } from "../interface/urls-publiques";
import type { Process, RequetePublique } from "../interface/urls-publiques";
import type { ModeApp } from "../mode";
import type { DefinitionRoute, Famille } from "../routes";
import { drapeauxVoix } from "../voix/config";

const SANS_CACHE = {
  "cache-control": "no-cache, no-store, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};
const PAGE_ABSENTE = (fichier: string): string =>
  `<h1>${fichier} missing</h1><p>Run <code>./elpis start</code> from the project root.</p>`;
const PAGE_ADMIN_SEPAREE =
  "<!doctype html><meta charset=utf-8>" +
  "<title>Admin separated</title>" +
  "<style>body{font-family:system-ui;max-width:560px;margin:8em auto;padding:2em;" +
  "background:#f8fafc;color:#1e293b;border-radius:12px}</style>" +
  "<h2>Console d'administration</h2>" +
  "<p>L'application d'administration s'exécute désormais dans un " +
  "processus séparé pour réduire la surface d'attaque côté usager.</p>" +
  "<p>Configurez la variable d'environnement <code>ADMIN_PUBLIC_URL</code> " +
  "(ex&nbsp;: <code>http://votre-host:8002/admin</code>) pour activer la " +
  "redirection automatique.</p>";

type Dict = Record<string, unknown>;

function dict(v: unknown): Dict | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

function requetePublique(req: FastifyRequest): RequetePublique {
  const entete = (nom: string): string | undefined => {
    const v = req.headers[nom];
    return Array.isArray(v) ? v[0] : v;
  };
  return { entete, hoteClient: req.ip, schema: req.protocol };
}

/** Vrai si les process du core n'écoutent que la boucle locale (`security.listen`, HTTPS, `BIND`) ; illisible → faux. */
function ecouteEnBouclage(): boolean {
  try {
    const defaut = hotePourConfig(configView() as Record<string, unknown>);
    const { hote } = adresseEcoute(process.env["BIND"], "main", defaut);
    return hote === "127.0.0.1" || hote === "::1" || hote === "localhost";
  } catch {
    return false;
  }
}

function urlPublique(nomEnv: string, req: FastifyRequest, cible: Process): string {
  return resoudreUrlPublique((process.env[nomEnv] ?? "").trim(), requetePublique(req), cible, {
    actif: httpsEnabled(),
    ports: httpsPorts(),
    bouclage: ecouteEnBouclage(),
  });
}

interface ImageStockee {
  type: string;
  octets: Buffer;
  empreinte: string;
}

/** Logo par défaut d'Elpis : image de l'accueil, du panneau latéral et avatar de l'assistant. */
const LOGO_ELPIS = "static/elpis-256.png";
/** Types servis pour le logo de l'application (le recadrage de l'interface produit du PNG ou du WebP). */
const TYPES_LOGO = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/** `(mimetype, octets, empreinte)` d'une image stockée en data-URI (base64 décodé comme `b64decode`), ou rien. */
function imageDataUri(brut: unknown): ImageStockee | undefined {
  if (typeof brut !== "string" || !brut.startsWith("data:")) return undefined;
  const virgule = brut.indexOf(",");
  if (virgule < 0) return undefined;
  const type = brut.slice(5, virgule).split(";")[0] || "image/png";
  let octets: Buffer;
  try {
    octets = urlsafeB64Decode(brut.slice(virgule + 1).replace(/[-_]/g, ""));
  } catch {
    return undefined;
  }
  return { type, octets, empreinte: createHash("sha256").update(octets).digest("hex").slice(0, 16) };
}

function logoAccueil(): ImageStockee | undefined {
  return imageDataUri(dict(configView()["welcome"])?.["image_b64"]);
}

/** Logo chargé par l'administrateur (`app_info.logo_b64`), d'un type d'image servi seulement ; c'est aussi l'avatar de l'assistant. */
function logoApplication(): ImageStockee | undefined {
  const logo = imageDataUri(dict(configView()["app_info"])?.["logo_b64"]);
  return logo && logo.octets.length > 0 && TYPES_LOGO.has(logo.type.toLowerCase()) ? logo : undefined;
}

function configPublique(req: FastifyRequest, mode: ModeApp): Dict {
  const vue = configView() as Dict;
  const defautAccueil = {
    type: "image",
    icon: "ph-sparkle text-blue-500",
    size: 112,
    width: 112,
    height: 112,
    image_b64: LOGO_ELPIS,
  };
  let accueil: Dict = { ...defautAccueil, ...(dict(vue["welcome"]) ?? {}) };
  if (accueil["type"] === "image" && !veritePy(accueil["image_b64"]))
    accueil["image_b64"] = defautAccueil.image_b64;
  const logo = logoAccueil();
  if (logo) accueil = { ...accueil, image_b64: `/api/welcome-image?v=${logo.empreinte}` };
  const fonctions = dict(vue["features"]) ?? {};
  const [stt, tts] = drapeauxVoix();
  const logoApp = logoApplication();
  return {
    welcome: accueil,
    app_info:
      "app_info" in vue
        ? vue["app_info"]
        : {
            name: "Elpis",
            version: "0.1.1",
            team_name: "Elpis",
            engine: "llama.cpp",
            description: "",
            icon_type: "phosphor",
            icon: "ph-robot",
            icon_color: "#ffffff",
            icon_bg: "#0f172a",
            logo_b64: "",
          },
    // Écart voulu au Python : adresse à empreinte du logo de l'application, avatar de l'assistant partout.
    app_logo_url: logoApp ? `/api/app-logo?v=${logoApp.empreinte}` : LOGO_ELPIS,
    login_page:
      "login_page" in vue
        ? vue["login_page"]
        : {
            title: "Connexion",
            subtitle: "",
            icon_type: "phosphor",
            icon: "ph-robot",
            icon_color: "#ffffff",
            icon_bg: "#2563eb",
            logo_b64: "",
            bg_color: "",
            card_color: "#ffffff",
            text_color: "",
            btn_color: "#0f172a",
          },
    admin_url: urlPublique("ADMIN_PUBLIC_URL", req, "admin"),
    main_url: urlPublique("MAIN_PUBLIC_URL", req, "main"),
    app_mode: mode,
    features: {
      opencode: fonctions["opencode"] !== false,
      agents: Boolean(config.AGENTS_ENABLED),
      office_preview: fonctions["office_preview"] !== false,
      voice_stt: stt,
      voice_tts: tts,
    },
  };
}

/** Routes de l'interface d'un process ; le dossier `frontend/` et le BUILD_ID viennent de la config. */
export function creerFamilleInterface(mode: ModeApp): Famille {
  const frontend = join(config.PROJECT_ROOT, "frontend");
  const pages = new Pages(frontend, config.BUILD_ID);
  const page =
    (fichier: string, entetes: Record<string, string>) => (_req: FastifyRequest, rep: FastifyReply) => {
      let html: string;
      try {
        html = pages.rendre(fichier);
      } catch (e) {
        if (mode !== "admin" || (e as { code?: string }).code !== "ENOENT") throw e;
        return rep.code(500).type("text/html; charset=utf-8").send(PAGE_ABSENTE(fichier));
      }
      // CSP des pages de l'application, selon `security.csp` (relu à chaque page : bascule sans redémarrage).
      return rep
        .type("text/html; charset=utf-8")
        .headers({ ...entetes, ...enteteCsp(modeCspConfigure()) })
        .send(html);
    };
  const adminRedirige = (req: FastifyRequest, rep: FastifyReply) => {
    const cible = urlPublique("ADMIN_PUBLIC_URL", req, "admin");
    if (cible) return rep.redirect(quotePy(cible, ":/%#?=@[]!$&'()*+,;"), 302);
    return rep.type("text/html; charset=utf-8").send(PAGE_ADMIN_SEPAREE);
  };
  const routes: DefinitionRoute[] = [
    {
      methode: ["GET", "HEAD"],
      chemin: "/static/*",
      processus: ["main", "admin"],
      acces: "public",
      montage: true,
      traiter: servirStatique(frontend),
    },
    {
      // Aperçu HTML des blocs de code : sa propre politique (about:srcdoc hériterait de celle de la page).
      methode: "GET",
      chemin: CHEMIN_APERCU_CODE,
      processus: ["main", "admin"],
      acces: "public",
      traiter: (_req, rep) =>
        rep
          .type("text/html; charset=utf-8")
          .headers({ ...SANS_CACHE, "content-security-policy": POLITIQUE_APERCU_CODE })
          .send(PAGE_APERCU_CODE),
    },
    {
      methode: "GET",
      chemin: "/api/public-config",
      processus: ["main", "admin"],
      acces: "public",
      traiter: (req) => configPublique(req, mode),
    },
    {
      methode: "GET",
      chemin: "/api/welcome-image",
      processus: ["main"],
      acces: "public",
      traiter: (_req, rep) => {
        const logo = logoAccueil();
        if (!logo) throw new HttpError(404, "Aucun logo d'accueil stocké");
        return rep
          .type(logo.type.startsWith("text/") ? `${logo.type}; charset=utf-8` : logo.type)
          .headers({ "cache-control": "public, max-age=31536000, immutable", etag: `"${logo.empreinte}"` })
          .send(logo.octets);
      },
    },
    {
      // Propre au TS : logo de l'application servi à part (le data-URI ne se répète pas dans chaque bulle).
      methode: "GET",
      chemin: "/api/app-logo",
      processus: ["main", "admin"],
      acces: "public",
      traiter: (_req, rep) => {
        const logo = logoApplication();
        if (!logo) throw new HttpError(404, "Aucun logo d'application stocké");
        return rep
          .type(logo.type)
          .headers({
            "cache-control": "public, max-age=31536000, immutable",
            etag: `"${logo.empreinte}"`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          })
          .send(logo.octets);
      },
    },
  ];
  if (mode === "admin") {
    for (const chemin of ["/", "/admin", "/admin/"]) {
      routes.push({
        methode: "GET",
        chemin,
        processus: ["admin"],
        acces: "public",
        traiter: page("admin.html", { "cache-control": SANS_CACHE["cache-control"] }),
      });
    }
  } else {
    routes.push({
      methode: "GET",
      chemin: "/",
      processus: ["main"],
      acces: "public",
      traiter: page("index.html", SANS_CACHE),
    });
    for (const chemin of ["/admin", "/admin/"]) {
      routes.push({ methode: "GET", chemin, processus: ["main"], acces: "public", traiter: adminRedirige });
    }
  }
  return { nom: "interface", routes };
}
