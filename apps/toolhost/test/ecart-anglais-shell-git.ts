// SPDX-License-Identifier: MIT
/** apps/toolhost/test/ecart-anglais-shell-git.ts — écart voulu au Python : textes des familles shell et git renvoyés au modèle en anglais (harnais B-13) ; chaque entrée met l'attendu Python en anglais. */

const TEXTES: [RegExp, string][] = [
  // mode détaché : hint du pid et du journal, renvoi vers shell_job (outil propre au TS)
  [
    /Processus détaché \(pid (\d+)\)\. Sortie dans (\S+) — consulte-la avec read_file ou `tail -n 50 (\S+)` ; arrête avec `kill (\d+)`\./g,
    "Detached process (pid $1). Its output goes to $2: read it with read_file or `tail -n 50 $3`; stop it with `kill $4`. " +
      'Nothing wakes you when it ends: to be woken (exit, log line, port), use shell_job(action="start") ' +
      'or execute_shell(on_timeout="detach_and_wake") (no background=true).',
  ],
  // code 127 : python absent, commande introuvable
  [
    /`python` n'existe pas dans le conteneur — utilise `python3` \(ou `pip3`\)\./g,
    "`python` does not exist in the container: use `python3` (or `pip3`).",
  ],
  [
    /Commande introuvable \(127\)\. Vérifie le nom, ou installe-la \(`pip install --user …` \/ `npm install -g …`\)\./g,
    "Command not found (127). Check the name, or install it (`pip install --user …` / `npm install -g …`).",
  ],
  // délai dépassé : renvoi vers shell_job (outil propre au TS)
  [
    /Pour un serveur ou un processus long, relance avec background=true \(retour immédiat \+ log\)\./g,
    'For a server or a long-running process, use shell_job(action="start") instead (immediate return, ' +
      'woken when it ends, no polling), or retry with on_timeout="detach_and_wake": the command then ' +
      "keeps running past the timeout and wakes you when it exits.",
  ],
  // pannes du bac et de l'agent rendues par l'exécuteur
  [/Container (\S+) n'a pas pu démarrer/g, "container $1 could not start"],
  [/agent_unavailable: client de l'agent non installé/g, "agent_unavailable: sandbox agent unavailable"],
  [/agent_unavailable: agent muet/g, "agent_unavailable: sandbox agent unavailable"],
  [/^permission: refus$/g, "permission"],
  // coupe des sorties git
  [/\[tronqué : (\d+) caractères omis sur (\d+)\]/g, "[truncated: $1 of $2 characters omitted]"],
];

/** Texte attendu (Python) mis en anglais. */
export function enAnglais(texte: string): string {
  return TEXTES.reduce((t, [re, par]) => t.replace(re, par), texte);
}

/** Valeur attendue (Python) dont chaque chaîne est mise en anglais. */
export function enAnglaisProfond<T>(v: T): T {
  if (typeof v === "string") return enAnglais(v) as T;
  if (Array.isArray(v)) return v.map((x) => enAnglaisProfond(x)) as T;
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enAnglaisProfond(x)])) as T;
  return v;
}
