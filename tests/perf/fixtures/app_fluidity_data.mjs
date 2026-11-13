// SPDX-License-Identifier: MIT
/** tests/perf/fixtures/app_fluidity_data.mjs — données réalistes du banc de fluidité de l'application : 30 conversations courtes, une longue (plus de 150 messages : code, tableaux, images, outils, réflexions), comptes de la console */
import zlib from "node:zlib";

import { demarrerFauxMcp } from "../../frontend/lib/faux-mcp.mjs";

export const TITRE_LONGUE = "Longue conversation de travail";
export const MARQUE_LONGUE_FIN = "Synthèse finale du chantier";
export const MARQUE_LONGUE_DEBUT = "Point de départ du chantier";
export const N_COURTES = 30;
export const titreCourte = (i) => `Court ${String(i).padStart(2, "0")} : ${SUJETS[i % SUJETS.length]}`;
const SUJETS = [
  "recette de pâtes",
  "voyage à Lyon",
  "budget du mois",
  "lecture du soir",
  "jardin d'hiver",
  "vélo électrique",
];

/** Image PNG en dégradé (data URL), encodée sans dépendance. */
export function imagePng(largeur = 480, hauteur = 270, graine = 1) {
  const brut = Buffer.alloc((largeur * 3 + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) {
    const o = y * (largeur * 3 + 1);
    for (let x = 0; x < largeur; x++) {
      brut[o + 1 + x * 3] = (x * 255) / largeur;
      brut[o + 2 + x * 3] = (y * 255) / hauteur;
      brut[o + 3 + x * 3] = (graine * 53) % 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const bloc = (type, data) => {
    const t = Buffer.from(type, "ascii");
    const l = Buffer.alloc(4);
    l.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([l, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(brut)),
    bloc("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + png.toString("base64");
}

const code = (i) => `\`\`\`python
# Étape ${i} : agrégation des relevés
import statistics
from dataclasses import dataclass, field


@dataclass
class Releve${i}:
    nom: str
    valeurs: list[float] = field(default_factory=list)

    def ajouter(self, v: float) -> None:
        self.valeurs.append(v)

    def resume(self) -> dict:
        if not self.valeurs:
            return {"n": 0}
        t = sorted(self.valeurs)
        return {
            "n": len(t),
            "mediane": statistics.median(t),
            "p95": t[int(len(t) * 0.95) - 1],
            "max": t[-1],
        }


def charger(chemin: str) -> list[Releve${i}]:
    with open(chemin, encoding="utf-8") as f:
        return [Releve${i}(ligne.strip()) for ligne in f if ligne.strip()]
\`\`\``;

const codeTs = (i) => `\`\`\`ts
export async function lireSession${i}(cle: string): Promise<Session | null> {
  const brut = await stockage.lire(\`session:\${cle}\`);
  if (!brut) return null;
  const s = JSON.parse(brut) as Session;
  return s.expire > Date.now() ? s : null;
}
\`\`\``;

const tableau = (i) => `| Service | Latence p50 | Latence p95 | Erreurs | Remarque |
|---|---:|---:|---:|---|
| main | ${40 + i} ms | ${120 + i} ms | 0,1 % | stable |
| admin | ${30 + i} ms | ${90 + i} ms | 0 % | rien à signaler |
| toolhost | ${55 + i} ms | ${210 + i} ms | 0,4 % | pics à l'ouverture des sandboxes |
| rag | ${80 + i} ms | ${400 + i} ms | 1,2 % | index en reconstruction |
| navigateur | ${120 + i} ms | ${900 + i} ms | 2,0 % | captures coûteuses |`;

const paragraphe = (i) =>
  `Le point ${i} touche la **stabilité du rendu** et la façon dont les données arrivent à l'écran. ` +
  "Chaque étape lit les relevés, les regroupe par minute puis calcule la médiane et le 95e centile ; " +
  "les écarts trop grands sont signalés dans le journal, avec `niveau=warn` et le nom du service concerné. ";

const appel = (id, nom, args) => ({
  id,
  type: "function",
  function: { name: nom, arguments: JSON.stringify(args) },
});
const resultat = (id, contenu) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(contenu) });

/** Réponse de l'assistant n° i de la longue conversation : un type de contenu par rang (texte, code, tableau, outils, réflexion…). */
function reponseLongue(i, total) {
  const base = { role: "assistant", model: "faux-modele" };
  if (i === total - 1)
    return {
      ...base,
      content: `## ${MARQUE_LONGUE_FIN}\n\n${paragraphe(i)}\n\n${tableau(i)}\n\n- tout est vérifié\n- rien n'est poussé`,
    };
  switch (i % 8) {
    case 0:
      return {
        ...base,
        content: `${paragraphe(i)}\n\n- première remarque, courte ;\n- deuxième remarque, un peu plus longue pour voir le retour à la ligne dans la colonne ;\n- troisième remarque.\n\n${paragraphe(i)}`,
      };
    case 1:
      return {
        ...base,
        content: `Voici le module demandé :\n\n${code(i)}\n\nIl se lance avec \`python -m releves\`.`,
      };
    case 2:
      return {
        ...base,
        content: `Les mesures de la semaine :\n\n${tableau(i)}\n\n> Les chiffres du service **rag** sont pris pendant la reconstruction de l'index.`,
      };
    case 3:
      return {
        ...base,
        content: `J'ai lu le fichier puis vérifié les appels.\n\n${codeTs(i)}\n\n${paragraphe(i)}`,
        tool_history: [
          {
            role: "assistant",
            content: "Je lis le fichier de session.",
            tool_calls: [appel(`l${i}a`, "read_file", { path: "apps/core/src/session.ts" })],
          },
          resultat(`l${i}a`, { success: true, content: codeTs(i).replace(/```\w*\n?/g, "") }),
          {
            role: "assistant",
            content: "Je cherche les appelants.",
            tool_calls: [
              appel(`l${i}b`, "shell_exec", { command: 'grep -rn "lireSession" apps/core/src | head' }),
            ],
          },
          resultat(`l${i}b`, {
            success: true,
            stdout: "apps/core/src/session.ts:12\napps/core/src/connexion.ts:42\n",
            exit_code: 0,
          }),
        ],
        tool_meta: { steps: { [`l${i}a`]: { ms: 120 }, [`l${i}b`]: { ms: 340 } } },
      };
    case 4:
      return {
        ...base,
        content: `### Étape ${i}\n\n${paragraphe(i)}\n\n1. lire la configuration ;\n2. ouvrir la base ;\n3. lancer la migration.\n\n> À faire hors des heures de travail.`,
      };
    case 5:
      return {
        ...base,
        // Le cœur retire `thinking` à l'enregistrement : la réflexion d'un message relu vient de `tool_meta.tail`.
        tool_meta: {
          steps: {},
          tail: {
            think:
              `L'utilisateur demande le point ${i}. Je relis les étapes précédentes, compare les latences et cherche ce qui a changé. `.repeat(
                6,
              ),
            think_ms: 2400,
          },
        },
        content: `Après réflexion : ${paragraphe(i)}`,
      };
    case 6:
      return { ...base, content: `${paragraphe(i)}\n\n${code(i)}\n\n${tableau(i)}` };
    default:
      return { ...base, content: `Réponse courte ${i} : c'est fait, la configuration est à jour.` };
  }
}

/** Messages de la longue conversation (`echanges` questions et réponses) ; une question sur sept porte une image. */
export function longueConversation(echanges = 80) {
  const messages = [];
  for (let i = 0; i < echanges; i++) {
    const texte =
      i === 0
        ? `${MARQUE_LONGUE_DEBUT} : peux-tu m'aider sur le point ${i} ?`
        : `Question ${i} : peux-tu détailler le point ${i}, avec un exemple ?`;
    if (i % 7 === 3)
      messages.push({
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imagePng(480, 270, i) } },
          { type: "text", text: texte },
        ],
      });
    else messages.push({ role: "user", content: texte });
    messages.push(reponseLongue(i, echanges));
  }
  return messages;
}

/** Pose les données : conversations, réglages, serveurs MCP, skills et routines d'alice ; comptes de la console. Rend les identifiants utiles aux gestes et l'arrêt du faux serveur MCP. */
export async function poserDonnees(core, Client) {
  const alice = new Client(core.urlMain);
  await alice.req("POST", "/api/login-lite", core.comptes.user);
  const nouveau = async (titre, messages) => {
    const { id } = await alice.req("POST", "/api/saved/chats/new", {});
    await alice.req("PUT", `/api/saved/chats/${id}/save-messages`, { title: titre, messages });
    return id;
  };
  const ids = { courtes: [] };
  ids.longue = await nouveau(TITRE_LONGUE, longueConversation(80));
  for (let i = 1; i <= N_COURTES; i++)
    ids.courtes.push(
      await nouveau(titreCourte(i), [
        { role: "user", content: `${titreCourte(i)} : question 1` },
        { role: "assistant", content: `Réponse **${i}** : ${paragraphe(i)}` },
        { role: "user", content: `${titreCourte(i)} : question 2` },
        { role: "assistant", content: `Deuxième réponse ${i}.\n\n- un point\n- un autre point` },
      ]),
    );
  // Conversations d'actions (renommer, archiver, supprimer) : séparées pour que les gestes se rejouent à chaque passe.
  ids.actions = [];
  for (let i = 1; i <= 12; i++)
    ids.actions.push(
      await nouveau(`Action ${String(i).padStart(2, "0")}`, [
        { role: "user", content: `Action ${i}` },
        { role: "assistant", content: "Bien." },
      ]),
    );
  // Deux serveurs MCP de test (faux serveur HTTP, quatre outils), réglages qui ouvrent le panneau MCP et l'éditeur.
  const outils = ["chercher", "lire", "resumer", "traduire"].map((name) => ({
    name,
    description: `Outil ${name} du serveur de test`,
    reponse: () => `${name} : ok`,
  }));
  const mcp = [
    await demarrerFauxMcp({ nom: "docs-test", outils }),
    await demarrerFauxMcp({ nom: "tickets-test", outils }),
  ];
  await alice.req("PUT", "/api/settings", { enable_mcp: true, enable_editor: true });
  // Un compte ne peut pas déclarer une adresse interne : les serveurs de test sont publiés par l'administrateur.
  const publieur = new Client(core.urlMain);
  await publieur.req("POST", "/api/login-lite", core.comptes.admin);
  for (const [i, m] of mcp.entries())
    await publieur
      .req("POST", "/api/mcp/shared-servers", {
        name: ["Documentation", "Tickets"][i],
        type: "http",
        url: m.url,
        auth_mode: "",
        enabled: true,
      })
      .catch((e) => console.error(`serveur MCP partagé non publié : ${e.message}`));
  for (let i = 1; i <= 5; i++)
    await alice
      .req("POST", "/api/skills", {
        scope: "user",
        name: `banc-skill-${i}`,
        description: `Skill de test ${i}`,
        body: `# Skill ${i}\n\nÉtapes à suivre pour la tâche ${i}.`,
      })
      .catch(() => {});
  for (let i = 1; i <= 5; i++)
    await alice
      .req("POST", "/api/routines", {
        name: `Routine ${i}`,
        cron_expr: `0 ${7 + i} * * 1-5`,
        task_prompt: `Résume les nouveautés du jour (${i}).`,
        enabled: false,
      })
      .catch(() => {});
  // Console : 40 comptes pour remplir le tableau des utilisateurs.
  const admin = new Client(core.urlAdmin);
  await admin.req("POST", "/api/login-lite", core.comptes.admin);
  for (let i = 1; i <= 40; i++)
    await admin
      .req("POST", "/api/admin/users/new", {
        username: `compte${String(i).padStart(2, "0")}`,
        password: `Compte-fixture-2026!${i}`,
        role: "user",
      })
      .catch(() => {});
  return { ids, alice, admin, arreter: async () => Promise.all(mcp.map((m) => m.arreter?.())) };
}

const SOURCE_TS = (nom, fonction) =>
  `// ${nom} — module de démonstration du bac\nimport { createServer } from "node:http";\n\n` +
  Array.from(
    { length: 40 },
    (_, i) =>
      `export function ${i ? `${fonction}${i}` : fonction}(port = ${8000 + i}): void {\n  const s = createServer((req, res) => res.end("ok ${i}"));\n  s.listen(port);\n}\n`,
  ).join("\n");

/** Fichiers du bac simulé : `src/` (dont serveur.ts et routes.ts), une vingtaine de dossiers de modules, des fichiers à la racine. */
export const FICHIERS_BAC = {
  "src/serveur.ts": SOURCE_TS("serveur.ts", "demarrerServeur"),
  "src/routes.ts": SOURCE_TS("routes.ts", "declarerRoutes"),
  "README.md": "# Projet de démonstration\n\nBac simulé du banc de fluidité.\n",
};
for (let d = 1; d <= 20; d++)
  for (let f = 1; f <= 8; f++)
    FICHIERS_BAC[`modules/m${d}/fichier${f}.ts`] = SOURCE_TS(`fichier${f}.ts`, `module${d}f${f}`);

/** Arbre du bac au format de /api/sandbox/tree. */
export const ARBRE_BAC = (() => {
  const racine = [];
  const dossier = (liste, nom, chemin) => {
    let d = liste.find((x) => x.name === nom && x.type === "folder");
    if (!d) liste.push((d = { name: nom, path: chemin, type: "folder", children: [] }));
    return d.children;
  };
  for (const chemin of Object.keys(FICHIERS_BAC)) {
    const parties = chemin.split("/");
    let liste = racine;
    for (let i = 0; i < parties.length - 1; i++)
      liste = dossier(liste, parties[i], parties.slice(0, i + 1).join("/"));
    liste.push({ name: parties[parties.length - 1], path: chemin, type: "file" });
  }
  return racine;
})();
