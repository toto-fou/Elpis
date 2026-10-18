// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/desktop.ts — famille `desktop` servie par l'hôte : 13 outils de @elpis/bureau sur les définitions des goldens Python, ports du bureau branchés sur l'hôte (pixels, catalogue d'erreurs, rappels au core). */
import { getUserSandbox, profilRetenu, racineTravail } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { decoderUtf8Py } from "@elpis/commun";
import {
  installerAncres,
  installerComptesBureau,
  installerPrimitivesBureau,
  installerSocleBureau,
  outilDesktopExpose,
  outilsDesktopExposes,
  PRIMITIVES_AGENT,
} from "@elpis/bureau";
import type { AncreEpinglee, PortAncres, ServicesOutilsBureau } from "@elpis/bureau";
import type { AgentClient } from "@elpis/fichiers";
import { py } from "@elpis/http";
import type { SchemaPy } from "@elpis/http";
import { dimensionsImage, recadrerCapture, reduireLargeur, signatureCapture } from "@elpis/images";
import { err, getUsername, Heartbeat, outilDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden, ParametrePython } from "@elpis/outils-mcp";
import goldenBrut from "@elpis/outils-mcp/goldens/desktop-brut.json" with { type: "json" };
import goldenDesktop from "@elpis/outils-mcp/goldens/desktop.json" with { type: "json" };

import type { Journal } from "../journal";
import type { ClientRappel, CompteSigne } from "../rappel";
import type { FabriqueNative } from "./natives";

export const AGENT_UTILISATEUR_HOTE = "elpis-toolhost";

const GOLDENS: readonly Golden[] = [goldenDesktop as Golden, goldenBrut as Golden];

/** Type pydantic d'une annotation Python des goldens (`str`, `int`, `bool`, `Optional[…]`, `List[…]`). */
function schemaPy(annotation: string): SchemaPy<unknown> {
  const optionnel = /^Optional\[(.*)\]$/u.exec(annotation);
  if (optionnel) return py.optional(schemaPy(optionnel[1] ?? ""));
  const liste = /^List\[(.*)\]$/u.exec(annotation);
  if (liste) return py.list(schemaPy(liste[1] ?? ""));
  if (annotation === "str") return py.str();
  if (annotation === "int") return py.int();
  if (annotation === "bool") return py.bool();
  throw new Error(`annotation Python non prise en charge : ${annotation}`);
}

/** Signature validée comme FastMCP : paramètres, types et défauts de la fonction Python du golden. */
function signatureDu(parametres: readonly ParametrePython[]): DefinitionOutil["signature"] {
  return Object.fromEntries(
    parametres.map((p) => [
      p.nom,
      p.requis ? schemaPy(p.annotation) : schemaPy(p.annotation).defaut(p.defaut ?? null),
    ]),
  );
}

/** `_load_sandbox_automation` : fichier du `/work` du compte lu par l'agent de son bac (`Espace.lire`), profil réseau effectif, UTF-8 strict ; compte inconnu = `""`, toute autre panne levée (le bureau rend `""`). */
export function lecteurSandbox(rappel: ClientRappel): ServicesOutilsBureau["lireSandbox"] {
  return async (username, chemin, maxOctets) => {
    const id = await rappel.identityForUsername(username);
    if (id === null) return "";
    const bac = getUserSandbox(
      id.user_id,
      id.username,
      await racineTravail(id.username),
      profilRetenu(id.user_id, id.network_profile_id || "isolated"),
    );
    return decoderUtf8Py((await (bac.agent as AgentClient).read(chemin, { maxBytes: maxOctets })).data);
  };
}

/** `nom::cible` d'`obsKey` : compte (assaini, sans `::`) et cible. */
function decouperPortee(scope: string): [string, string] {
  const i = scope.indexOf("::");
  return i < 0 ? [scope, ""] : [scope.slice(0, i), scope.slice(i + 2)];
}

/** Mémoire des ancres par rappel au core, au nom du compte de la portée (identité résolue puis signée). */
function ancresParRappel(rappel: ClientRappel): PortAncres {
  const compte = async (nom: string): Promise<CompteSigne | null> => {
    const id = await rappel.identityForUsername(nom);
    return id === null ? null : { user_id: id.user_id, username: id.username };
  };
  return {
    lookupActionAnchor: async (scope, requete) => {
      const [nom, cible] = decouperPortee(scope);
      const c = await compte(nom);
      return c === null ? null : ((await rappel.ancre(c, cible, requete)) as AncreEpinglee | null);
    },
    recordActionAnchor: async (scope, requete, autoId, o) => {
      const [nom, cible] = decouperPortee(scope);
      const c = await compte(nom);
      if (c !== null)
        await rappel.noterAncre(c, cible, requete, { auto_id: autoId, role: o.role, center: o.center });
    },
  };
}

/** Ports de @elpis/bureau posés pour l'hôte : pixels de @elpis/images, `err` du socle MCP, comptes, notification et ancres par rappel. */
export function brancherBureau(rappel: ClientRappel, journal: Journal): void {
  installerSocleBureau({
    images: {
      dimensions: dimensionsImage,
      signature: signatureCapture,
      recadrer: recadrerCapture,
      reduireLargeur,
    },
    err: (code, message, o = {}) => {
      const { nextAction, ...reste } = o;
      return err(code, message, { ...reste, ...(nextAction ? { next_action: nextAction } : {}) });
    },
    agentUtilisateur: AGENT_UTILISATEUR_HOTE,
    services: {
      idCompte: async (nom) => (await rappel.identityForUsername(nom))?.user_id ?? null,
      lireSandbox: lecteurSandbox(rappel),
      notifier: async (compte, titre, corps) => {
        if (!(await rappel.creerNotification(compte, titre, corps)))
          journal.warn(`[desktop] notification d'automatisation non créée (compte ${compte.username})`);
      },
    },
  });
  installerPrimitivesBureau(PRIMITIVES_AGENT);
  installerComptesBureau({
    estAdmin: async (nom) => (await rappel.identityForUsername(nom))?.is_admin === true,
  });
  installerAncres(ancresParRappel(rappel));
}

/** Appel d'un outil exposé pour le compte de l'appel ; battement pendant `desktop_wait`. */
function traiterDesktop(nom: string) {
  return async (args: Dict, ctx: ContexteAppel): Promise<Dict> => {
    const outil = outilDesktopExpose(nom);
    if (outil === null) throw new Error(`outil desktop non exposé : ${nom}`);
    const username = getUsername(ctx);
    if (!outil.battement) return outil.gerer(username, args);
    return new Heartbeat(ctx).avec(() => outil.gerer(username, args));
  };
}

/** Famille `desktop` de l'hôte : outils exposés selon DESKTOP_DISABLE_SHELL et DESKTOP_EXPOSE_RAW_TOOLS, définitions et signatures des goldens. */
export const familleDesktop: FabriqueNative = ({ rappel, journal }) => {
  brancherBureau(rappel, journal);
  const outils = outilsDesktopExposes().map((o) => {
    const golden = GOLDENS.find((g) => g.fonctions[o.nom] !== undefined);
    if (golden === undefined) throw new Error(`outil desktop absent des goldens : ${o.nom}`);
    return outilDuGolden(golden, o.nom, {
      signature: signatureDu(golden.fonctions[o.nom]?.parametres ?? []),
      traiter: traiterDesktop(o.nom),
    });
  });
  return { famille: "desktop", outils };
};
