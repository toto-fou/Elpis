// SPDX-License-Identifier: MIT
/** apps/core/src/outils/mcp/famille-skill.ts — famille `skill` servie en processus (llm_core/tools/skill_tools.py, register_library) : définitions figées par le golden, signatures pydantic, corps de skills/outils.ts. */
import { getUsername, outilDuGolden, readMetaField, tokenIdentity } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenSkill from "@elpis/outils-mcp/goldens/skill.json" with { type: "json" };
import { py } from "@elpis/http";

import type { Dict } from "../../python";
import { skillAddFile, skillGet, skillReadFile, skillSave } from "../../skills/outils";
import type { AppelSkill, ArgsSkillSave } from "../../skills/outils";

const GOLDEN = goldenSkill as unknown as Golden;

/** Compte de l'appel (jeton client, `_meta`, puis `guest`), login reçu et notifications de l'appel. */
function appelDe(ctx: ContexteAppel): AppelSkill {
  return {
    username: getUsername(ctx),
    login: tokenIdentity() ?? readMetaField(ctx, "username"),
    info: (message) => ctx.info(message),
  };
}

/** Les quatre outils de `register_library` (ask_user est un intégré du core), dans l'ordre d'enregistrement Python. */
export function outilsSkill(): DefinitionOutil[] {
  return [
    outilDuGolden(GOLDEN, "skill_save", {
      signature: {
        name: py.str(),
        description: py.str(),
        body: py.str(),
        tags: py.optional(py.list(py.str())).defaut(null),
        domain: py.optional(py.str()).defaut(null),
      },
      traiter: (a: Dict, ctx) => skillSave(a as unknown as ArgsSkillSave, appelDe(ctx)),
    }),
    outilDuGolden(GOLDEN, "skill_add_file", {
      signature: { name: py.str(), path: py.str(), content: py.str() },
      traiter: (a: Dict, ctx) =>
        skillAddFile(a as { name: string; path: string; content: string }, appelDe(ctx)),
    }),
    outilDuGolden(GOLDEN, "skill_get", {
      signature: { name: py.str() },
      traiter: (a: Dict, ctx) => skillGet(a as { name: string }, appelDe(ctx)),
    }),
    outilDuGolden(GOLDEN, "skill_read_file", {
      signature: { name: py.str(), path: py.str() },
      traiter: (a: Dict, ctx) => skillReadFile(a as { name: string; path: string }, appelDe(ctx)),
    }),
  ];
}
