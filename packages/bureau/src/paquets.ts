// SPDX-License-Identifier: MIT
/** packages/bureau/src/paquets.ts — ce que le serveur remet aux postes du LAN : archive de l'agent bureau, paquet « prêt à tourner » d'un script du Studio, installeurs `install.sh` et `install.ps1` (shared_infra/desktop/routes.py). */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";

import {
  compilerRe,
  dateHeureLocale,
  ecrireZip,
  encoderUtf8Py,
  lowerPy,
  rstripPy,
  splitlinesPy,
  splitPy,
  stripPy,
  texteOu,
} from "@elpis/commun";

import { b64decodeStrict } from "./image";
import type { DateHeureZip, EntreeZipEcrite } from "@elpis/commun";

const EXCLUS = new Set([
  ".venv",
  "venv",
  "__pycache__",
  ".git",
  ".pytest_cache",
  "node_modules",
  ".mypy_cache",
  ".ruff_cache",
]);
const DOSSIERS_RUNTIME = ["elpis_auto", "backends"];
const FICHIERS_RUNTIME = ["normalize.py"];
const PAQUETS_SERVEUR = ["fastapi", "uvicorn"];
const CHEMIN_SUR = "(?:lib|assets)/[\\w.\\-/]+";
const deflateRawAsync = promisify(deflateRaw);

/** `_safe.fullmatch(rel)` : `\w` d'Unicode comme `re` de Python (« lib/données.py » admis). */
function cheminSur(rel: string): boolean {
  const m = compilerRe(CHEMIN_SUR).exec(rel);
  return m !== null && m.index === 0 && m[0].length === rel.length;
}

/** Archive écrite après une compression hors de la boucle d'événements (pool de libuv), mêmes octets que `deflateRawSync`. */
async function zipper(entrees: EntreeZipEcrite[]): Promise<Buffer> {
  for (const e of entrees) if (!e.stocke) e.compresse = await deflateRawAsync(e.donnees);
  return ecrireZip(entrees);
}

/** `time.localtime(time.time())[:6]` des `writestr` de Python. */
const maintenantZip = (): DateHeureZip => dateHeureLocale(Date.now());

/** `writestr(nom, données)` : date courante, `0o600`, compressé sauf `stocke`. */
function entreeEcrite(nom: string, donnees: string | Uint8Array, stocke = false): EntreeZipEcrite {
  return {
    nom,
    donnees: typeof donnees === "string" ? encoderUtf8Py(donnees) : donnees,
    dateHeure: maintenantZip(),
    attributsExternes: 0o600 << 16,
    stocke,
  };
}

/** `write(fichier, nom)` : date et mode du fichier sur disque. */
async function entreeFichier(chemin: string, nom: string, stocke = false): Promise<EntreeZipEcrite> {
  const [s, donnees] = await Promise.all([stat(chemin), readFile(chemin)]);
  return {
    nom,
    donnees,
    dateHeure: dateHeureLocale(s.mtimeMs),
    attributsExternes: (s.mode & 0xffff) << 16,
    stocke,
  };
}

/** `os.walk` élagué : fichiers (hors .pyc/.pyo) d'un dossier, relatifs, dossiers exclus ignorés. */
async function fichiersAgent(base: string, rel = ""): Promise<string[]> {
  const entrees = await readdir(path.join(base, rel), { withFileTypes: true });
  const fichiers: string[] = [];
  const dossiers: string[] = [];
  for (const e of entrees) {
    const lienVersDossier =
      e.isSymbolicLink() &&
      (await stat(path.join(base, rel, e.name)).then(
        (s) => s.isDirectory(),
        () => false,
      ));
    if (lienVersDossier) continue;
    if (e.isDirectory()) {
      if (!EXCLUS.has(e.name)) dossiers.push(e.name);
    } else if (!e.name.endsWith(".pyc") && !e.name.endsWith(".pyo"))
      fichiers.push(path.posix.join(rel, e.name));
  }
  for (const d of dossiers) fichiers.push(...(await fichiersAgent(base, path.posix.join(rel, d))));
  return fichiers;
}

async function estDossier(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

async function estFichier(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** `/api/desktop/agent-bundle` : sources de `desktop-agent/` zippées (code générique, aucun secret) ; `null` si le dossier manque. */
export async function archiveAgent(racine: string): Promise<Buffer | null> {
  const base = path.join(racine, "desktop-agent");
  if (!(await estDossier(base))) return null;
  const entrees: EntreeZipEcrite[] = [];
  for (const rel of await fichiersAgent(base))
    entrees.push(await entreeFichier(path.join(base, rel), `desktop-agent/${rel}`));
  return zipper(entrees);
}

/** `_bundle_slug` : nom de dossier et d'archive (`[a-z0-9_-]`, 64 caractères), `automatisation` par défaut. */
export function bundleSlug(name: unknown): string {
  const slug = lowerPy(stripPy(texteOu(name, "")))
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "automatisation").slice(0, 64);
}

const nomOs = (os: string): string => (os === "linux" ? "linux" : "windows");

/** `_runtime_requirements` : `requirements-<os>.txt` de l'agent sans les paquets de son serveur HTTP. */
export async function runtimeRequirements(base: string, os: string): Promise<string> {
  let brut: string;
  try {
    brut = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(path.join(base, `requirements-${nomOs(os)}.txt`)),
    );
  } catch (e) {
    if (e instanceof TypeError) throw e;
    brut =
      "Pillow\nmss\npyscreeze\npytweening\npyperclip\n" +
      (os === "linux" ? "python-xlib\nPyGObject\n" : "pygetwindow\npyrect\npywinauto\n");
  }
  const lignes = splitlinesPy(brut).filter((l) => {
    const paquet = lowerPy(stripPy(splitPy(l, "#", 1)[0] ?? ""));
    return !(paquet && PAQUETS_SERVEUR.some((x) => paquet.startsWith(x)));
  });
  return rstripPy(lignes.join("\n")) + "\n";
}

/** `_runtime_requirements_nodeps` : paquets installés en `--no-deps` (pyautogui sans ses dépendances GPL). */
export async function runtimeRequirementsNodeps(base: string, os: string): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(path.join(base, `requirements-${nomOs(os)}-nodeps.txt`)),
    );
  } catch (e) {
    if (e instanceof TypeError) throw e;
    return "pyautogui==0.9.54\n";
  }
}

/** `_bundle_run_bat` : lanceur Windows (venv local, wheels hors ligne, console UTF-8) ; aucune parenthèse dans les `echo` d'un bloc. */
export function bundleRunBat(slug: string): string {
  return (
    "@echo off\r\n" +
    `rem run.bat [--param=valeur ...] - execute ${slug}.py avec un venv local.\r\n` +
    "rem 1er lancement : creation du venv + installation des dependances, depuis\r\n" +
    "rem wheels\\windows (hors ligne) s'il existe, sinon depuis pip. Si l'agent\r\n" +
    "rem Elpis est deja installe sur la machine, run-script.bat de l'agent suffit.\r\n" +
    "setlocal\r\n" +
    "set HERE=%~dp0\r\n" +
    "set PY=%HERE%.venv\\Scripts\\python.exe\r\n" +
    "rem Console en UTF-8 le temps du script - coches, fleches et accents du rapport\r\n" +
    "rem lisibles - puis page de codes d'origine rendue a la sortie.\r\n" +
    "for /f \"tokens=2 delims=:\" %%a in ('chcp') do set OLDCP=%%a\r\n" +
    "chcp 65001 >nul\r\n" +
    "set PYTHONUTF8=1\r\n" +
    'if exist "%PY%" goto deps\r\n' +
    "echo Creation du venv...\r\n" +
    "rem Python : python-win\\ de l'agent (3.11, celui des wheels) s'il est a cote, sinon py/python.\r\n" +
    'if exist "%HERE%python-win\\python.exe" (\r\n' +
    '    "%HERE%python-win\\python.exe" -m venv "%HERE%.venv" || goto die\r\n' +
    "    goto deps\r\n" +
    ")\r\n" +
    'py -3.11 -m venv "%HERE%.venv" 2>nul && goto deps\r\n' +
    'py -3 -m venv "%HERE%.venv" 2>nul && goto deps\r\n' +
    'python -m venv "%HERE%.venv" || goto die\r\n' +
    ":deps\r\n" +
    'if exist "%HERE%.venv\\deps-ok" goto run\r\n' +
    "echo Installation des dependances - une seule fois...\r\n" +
    'if exist "%HERE%wheels\\windows" (\r\n' +
    '    "%PY%" -m pip install --no-index --find-links "%HERE%wheels\\windows" -r "%HERE%requirements.txt" && "%PY%" -m pip install --no-index --find-links "%HERE%wheels\\windows" --no-deps -r "%HERE%requirements-nodeps.txt" && goto depsok\r\n' +
    "    echo Wheels hors ligne inutilisables avec ce Python - les wheels sont cp311 - essai en ligne...\r\n" +
    ")\r\n" +
    '"%PY%" -m pip install -r "%HERE%requirements.txt" || (\r\n' +
    "    echo Installation impossible. Avec un Python 3.11 - ou python-win\\ de l'agent - les wheels hors ligne suffisent.\r\n" +
    "    goto die\r\n" +
    ")\r\n" +
    "rem pyautogui sans ses dependances : mouseinfo et pymsgbox - GPL, optionnels - ecartes.\r\n" +
    '"%PY%" -m pip install --no-deps -r "%HERE%requirements-nodeps.txt" || goto die\r\n' +
    ":depsok\r\n" +
    "rem pywin32 dans un venv : ses DLL doivent etre a cote de python.exe (sinon import win32api KO).\r\n" +
    'if exist "%HERE%.venv\\Lib\\site-packages\\pywin32_system32" copy /y "%HERE%.venv\\Lib\\site-packages\\pywin32_system32\\*.dll" "%HERE%.venv\\Scripts\\" >nul\r\n' +
    'echo ok> "%HERE%.venv\\deps-ok"\r\n' +
    ":run\r\n" +
    `"%PY%" -m elpis_auto "%HERE%${slug}.py" %*\r\n` +
    "set RC=%ERRORLEVEL%\r\n" +
    "rem Lance par double-clic - pas de console parente : la fenetre resterait\r\n" +
    "rem ouverte le temps de lire le resultat, sinon elle disparait comme un crash.\r\n" +
    'echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause\r\n' +
    "if defined OLDCP chcp %OLDCP% >nul\r\n" +
    "exit /b %RC%\r\n" +
    ":die\r\n" +
    'echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause\r\n' +
    "if defined OLDCP chcp %OLDCP% >nul\r\n" +
    "exit /b 2\r\n"
  );
}

/** `_bundle_run_sh` : lanceur Linux (venv local, wheels hors ligne sinon pip). */
export function bundleRunSh(slug: string): string {
  return (
    "#!/usr/bin/env bash\n" +
    `# run.sh [--param=valeur ...] — exécute ${slug}.py avec un venv local.\n` +
    "# 1er lancement : venv + dépendances, depuis wheels/linux (hors ligne) s'il\n" +
    "# existe, sinon depuis pip.\n" +
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
    'PY="$HERE/.venv/bin/python"\n' +
    'if [ ! -x "$PY" ]; then\n' +
    '    echo "Création du venv..."\n' +
    '    python3 -m venv "$HERE/.venv" || exit 2\n' +
    "fi\n" +
    'if [ ! -f "$HERE/.venv/deps-ok" ]; then\n' +
    '    echo "Installation des dépendances (une seule fois)..."\n' +
    "    ok=\n" +
    '    if [ -d "$HERE/wheels/linux" ]; then\n' +
    '        "$PY" -m pip install --no-index --find-links "$HERE/wheels/linux" -r "$HERE/requirements.txt" \\\n' +
    '            && "$PY" -m pip install --no-index --find-links "$HERE/wheels/linux" --no-deps -r "$HERE/requirements-nodeps.txt" && ok=1\n' +
    '        [ -n "$ok" ] || echo "Wheels hors ligne inutilisables avec ce Python (cp311) : essai en ligne..."\n' +
    "    fi\n" +
    "    # pyautogui sans ses dépendances : mouseinfo et pymsgbox (GPL, optionnels) écartés.\n" +
    '    [ -n "$ok" ] || { "$PY" -m pip install -r "$HERE/requirements.txt" \\\n' +
    '        && "$PY" -m pip install --no-deps -r "$HERE/requirements-nodeps.txt"; } || exit 2\n' +
    '    echo ok > "$HERE/.venv/deps-ok"\n' +
    "fi\n" +
    `cd "$HERE" && exec "$PY" -m elpis_auto "$HERE/${slug}.py" "$@"\n`
  );
}

/** `_bundle_readme` : la première ligne et la barre de « = » sont répétées 60 fois, comme le produit l'opérateur `*` de Python. */
export function bundleReadme(slug: string, os: string, avecWheels = false): string {
  return (
    `${slug} — script d'automatisation généré par Elpis Studio\n=`.repeat(60) +
    "\n\n" +
    "Contenu\n" +
    `  ${slug}.py            le script (éditable)\n` +
    "  elpis_auto/          le runtime (Session, cibles, attentes, rapport)\n" +
    "  backends/, normalize.py   accès à l'écran (UIA Windows / AT-SPI Linux)\n" +
    "  requirements.txt     dépendances Python du runtime\n" +
    "  run.bat / run.sh     lanceurs : venv local créé au premier lancement\n" +
    (avecWheels ? `  wheels/${os}/      dépendances HORS LIGNE (Python 3.11 : wheels cp311)\n` : "") +
    "\n" +
    "Exécuter (sur la machine à piloter)\n" +
    "  Windows :  run.bat --param=valeur\n" +
    "  Linux   :  ./run.sh --param=valeur\n" +
    "  ou, avec un Python où requirements.txt est installé :\n" +
    `             python -m elpis_auto ${slug}.py\n\n` +
    "Si l'agent Elpis est déjà installé sur la machine, le runtime y est :\n" +
    `  copiez seulement ${slug}.py à côté de l'agent et lancez run-script.bat ${slug}.py\n\n` +
    "Codes de sortie : 0 ok · 1 une vérification a échoué · 2 erreur d'exécution.\n" +
    "Rapport : rapports/<script>-<horodatage>/rapport.html (+ json, captures d'échec).\n" +
    "Paramètres : --cle=valeur, ou ELPIS_PARAM_CLE en variable d'environnement.\n" +
    "Options (avant le nom du script) : --dry-run (vol à blanc, rien n'est envoyé),\n" +
    "  --trace (capture + arbre à chaque étape, visualiseur dans rapport.html),\n" +
    "  --repeat N (stabilité : stabilite.html), --data jeu.csv (une exécution par ligne).\n\n" +
    "Dépendances : le lanceur installe depuis wheels/ (hors ligne) si le dossier est\n" +
    "là et que le Python est compatible (wheels cp311 → Python 3.11, ou python-win\\\n" +
    "de l'agent copié à côté), sinon depuis pip (internet). Un autre Python (3.12+)\n" +
    "marche en ligne. Pour forcer une réinstallation : effacer .venv\\deps-ok.\n\n" +
    "À SAVOIR\n" +
    "  • Lancez le script DEPUIS LE BUREAU de la machine (session ouverte, application\n" +
    "    visible) : dans une session SSH, un service ou une session verrouillée,\n" +
    "    l'arbre d'accessibilité est vide et chaque cible est « introuvable ».\n" +
    "  • run.bat lancé par double-clic garde sa console ouverte le temps de lire le\n" +
    "    résultat (touche pour fermer) ; depuis une console, il rend la main.\n" +
    "  • Attentes : timeout (15 s) = délai SANS activité à l'écran. Tant que quelque\n" +
    "    chose bouge (application qui se lance, chargement), l'attente se prolonge,\n" +
    "    jusqu'à patience (120 s, ELPIS_PATIENCE). Session(timeout=…, patience=…).\n" +
    '  • window="Titre" sur une action = fenêtre au premier plan si possible (le bureau\n' +
    "    « Program Manager » compris), jamais une panne : la cible est cherchée partout.\n" +
    "  • Windows : sans le Visual C++ Redistributable (mfc140u.dll), pywinauto est muet ;\n" +
    "    le runtime joue alors Toggle/Select/Invoke par UIA directement (comtypes) et\n" +
    "    clique pour de vrai sur les menus et pour les double-clics.\n" +
    "  • Un abandon (cible introuvable, vérification fausse) écrit quand même le rapport ;\n" +
    "    ELPIS_TRACE=1 affiche la trace complète.\n" +
    (os === "linux"
      ? "\nLinux : l'arbre d'accessibilité demande PyGObject + AT-SPI (paquets système,\nvoir requirements.txt).\n"
      : "")
  );
}

export type DemandePaquet = {
  code: string;
  slug: string;
  os: string;
  wheels: boolean;
  libs: Readonly<Record<string, unknown>>;
  assets: Readonly<Record<string, unknown>>;
};

/** `/api/desktop/automation-bundle` : script + runtime `elpis_auto` + dépendances + lanceurs + README ; `null` si le runtime manque. */
export async function paquetAutomatisation(racine: string, d: DemandePaquet): Promise<Buffer | null> {
  const base = path.join(racine, "desktop-agent");
  if (!(await estDossier(path.join(base, "elpis_auto")))) return null;
  const { slug, os } = d;
  const entrees: EntreeZipEcrite[] = [entreeEcrite(`${slug}/${slug}.py`, d.code)];
  for (const dossier of DOSSIERS_RUNTIME) {
    let noms: string[];
    try {
      noms = (await readdir(path.join(base, dossier), { withFileTypes: true }))
        .filter((e) => e.name.endsWith(".py") && !e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      noms = [];
    }
    for (const n of noms)
      entrees.push(await entreeFichier(path.join(base, dossier, n), `${slug}/${dossier}/${n}`));
  }
  for (const n of FICHIERS_RUNTIME)
    if (await estFichier(path.join(base, n)))
      entrees.push(await entreeFichier(path.join(base, n), `${slug}/${n}`));
  for (const [rel, texte] of Object.entries(d.libs))
    if (cheminSur(rel) && !rel.includes("..") && typeof texte === "string")
      entrees.push(entreeEcrite(`${slug}/${rel}`, texte));
  if (Object.keys(d.libs).length > 0 && !Object.keys(d.libs).includes("lib/__init__.py"))
    entrees.push(entreeEcrite(`${slug}/lib/__init__.py`, ""));
  for (const [rel, b64] of Object.entries(d.assets)) {
    if (!(cheminSur(rel) && !rel.includes("..") && typeof b64 === "string")) continue;
    let brut: Buffer;
    try {
      brut = b64decodeStrict(b64);
    } catch {
      continue;
    }
    if (brut.length > 0) entrees.push(entreeEcrite(`${slug}/${rel}`, brut, true));
  }
  entrees.push(entreeEcrite(`${slug}/requirements.txt`, await runtimeRequirements(base, os)));
  entrees.push(entreeEcrite(`${slug}/requirements-nodeps.txt`, await runtimeRequirementsNodeps(base, os)));
  entrees.push(entreeEcrite(`${slug}/run.bat`, bundleRunBat(slug)));
  entrees.push({
    nom: `${slug}/run.sh`,
    donnees: Buffer.from(bundleRunSh(slug), "utf-8"),
    dateHeure: [1980, 1, 1, 0, 0, 0],
    attributsExternes: 0o755 << 16,
    stocke: true,
  });
  const dossierWheels = path.join(base, "wheels", os);
  const avecWheels = d.wheels && (await estDossier(dossierWheels));
  if (avecWheels) {
    const roues = (await readdir(dossierWheels, { withFileTypes: true }))
      .filter((e) => e.name.endsWith(".whl") && !e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const n of roues)
      entrees.push(await entreeFichier(path.join(dossierWheels, n), `${slug}/wheels/${os}/${n}`, true));
  }
  entrees.push(entreeEcrite(`${slug}/README.txt`, bundleReadme(slug, os, avecWheels)));
  return zipper(entrees);
}

/** Gabarit de `install.sh` recopié à l'octet de routes.py (base en `__BASE__`). */
export const INSTALL_SH_PYTHON = `#!/usr/bin/env bash
set -euo pipefail
# Installeur desktop-agent — servi par __BASE__ (réseau local, sans auth).
BASE="__BASE__"
DIR="\${DESKTOP_AGENT_DIR:-$PWD/desktop-agent}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# HTTPS (frontal Caddy, cert LAN auto-signé) : vérif normale → CA locale → repli
# -k. DEUX sources pour la CA : Caddy la publie en clair sur :80, mais ce chemin
# n'existe pas sur un déploiement en https direct (ou :80 filtré) — l'app la sert
# donc aussi elle-même sur /api/cli/ca.crt. Sans cette seconde source on tombait
# en « -k » définitif alors qu'une vérification réelle était possible.
CURL_TLS=""
if [ "\${BASE#https://}" != "$BASE" ]; then
  HOST="\${BASE#https://}"; HOST="\${HOST%%[:/]*}"
  if curl -fsS -m 5 --head "$BASE/api/desktop/install.sh" >/dev/null 2>&1; then
    :      # certificat déjà reconnu par le poste (CA installée) — rien à faire
  else
    for CA_URL in "http://$HOST/ca.crt" "$BASE/api/cli/ca.crt"; do
      if curl -fsSk -m 5 "$CA_URL" -o "$TMP/ca.crt" 2>/dev/null \\
         && grep -q 'BEGIN CERTIFICATE' "$TMP/ca.crt" 2>/dev/null \\
         && curl -fsS -m 5 --cacert "$TMP/ca.crt" --head "$BASE/api/desktop/install.sh" >/dev/null 2>&1; then
        CURL_TLS="--cacert $TMP/ca.crt"
        echo "CA locale récupérée ($CA_URL) — téléchargement https vérifié."
        break
      fi
    done
    if [ -z "$CURL_TLS" ]; then
      CURL_TLS="-k"
      echo "AVERTISSEMENT : certificat https non vérifiable — téléchargement en mode non vérifié (-k)."
      echo "  Installez la CA de l'app sur ce poste ($BASE/api/cli/ca.crt) pour y remédier."
    fi
  fi
fi
echo "-> Téléchargement de l'agent depuis $BASE ..."
curl -fSL $CURL_TLS "$BASE/api/desktop/agent-bundle" -o "$TMP/desktop-agent.zip"
PARENT="$(dirname "$DIR")"; mkdir -p "$PARENT"
rm -rf "$DIR"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/desktop-agent.zip" "$PARENT"
cd "$DIR"
chmod +x install_agent.sh 2>/dev/null || true
# Délègue à l'installeur embarqué : venv + deps (HORS-LIGNE si wheels embarquées)
# + choix d'auto-démarrage. Piped => non-interactif (DESKTOP_SERVICE=1 = service).
exec bash install_agent.sh
`;

/** Sondes HTTPS en GET : FastAPI refuse HEAD (405) et la sonde du Python retombait toujours en mode non vérifié. */
export function sondesEnGet(gabarit: string, avant: string, apres: string, attendues: number): string {
  const morceaux = gabarit.split(avant);
  if (morceaux.length !== attendues + 1 || gabarit.includes(apres))
    throw new Error(`gabarit d'installeur : ${attendues} sondes « ${avant} » attendues`);
  return morceaux.join(apres);
}

/** Gabarit de `install.ps1` recopié à l'octet de routes.py (base en `__BASE__`), 100 % ASCII : PowerShell 5.1 lit les scripts sans BOM en ANSI. */
export const INSTALL_PS1_PYTHON = `# Installeur desktop-agent -- servi par __BASE__ (reseau local, sans auth).
$ErrorActionPreference = 'Stop'
$Base = '__BASE__'
# HTTPS (frontal Caddy, cert LAN auto-signe) : si la verification echoue, on la
# desactive POUR CE SCRIPT (PS7 : SkipCertificateCheck ; PS5.1 : callback).
if ($Base -like 'https://*') {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    # .NET Framework peut demarrer SANS TLS 1.2 alors que Caddy exige TLS >= 1.2
    # ("The underlying connection was closed") -- on l'ajoute AVANT tout appel.
    # 3072 = Tls12 (valeur numerique : l'enum manque sur les vieux .NET).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  }
  try { Invoke-WebRequest -UseBasicParsing -Method Head -Uri "$Base/api/desktop/install.ps1" -TimeoutSec 5 | Out-Null }
  catch {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      $PSDefaultParameterValues['Invoke-WebRequest:SkipCertificateCheck'] = $true
    } else {
      # PAS de scriptblock { $true } : .NET peut invoquer le callback sur un
      # thread SANS runspace PowerShell -> handshake avorte ("The underlying
      # connection was closed"). Callback C# COMPILE (Add-Type) = thread-safe.
      if (-not ('ElpisTrustAll' -as [type])) {
        Add-Type 'using System.Net;public class ElpisTrustAll{public static void Go(){ServicePointManager.ServerCertificateValidationCallback=delegate{return true;};}}'
      }
      [ElpisTrustAll]::Go()
    }
    Write-Host "Certificat https non verifiable (CA locale) -- verification desactivee pour ce script."
  }
}
$Dir = if ($env:DESKTOP_AGENT_DIR) { $env:DESKTOP_AGENT_DIR } else { Join-Path $PWD 'desktop-agent' }
$Parent = Split-Path -Parent $Dir
$Tmp = (New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ('desktop-agent-' + [guid]::NewGuid()))).FullName
$Zip = Join-Path $Tmp 'desktop-agent.zip'
Write-Host "-> Telechargement de l'agent depuis $Base ..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/desktop/agent-bundle" -OutFile $Zip
if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
Expand-Archive -Force -Path $Zip -DestinationPath $Parent
Set-Location $Dir
# Delegue a l'installeur embarque (Python standalone embarque + vrai venv
# hors-ligne via run.ps1 + auto-demarrage). Ensuite : double-clic run.bat.
& powershell -ExecutionPolicy Bypass -File "$Dir\\install_agent.ps1"
`;

const INSTALL_SH = sondesEnGet(INSTALL_SH_PYTHON, '--head "', '-o /dev/null "', 2);
const INSTALL_PS1 = sondesEnGet(INSTALL_PS1_PYTHON, "-Method Head -Uri", "-Method Get -Uri", 1);

/** `install.sh` servi à un poste sans session : télécharge l'agent depuis `base` (Host validé) ; sondes HTTPS en GET (E35). */
export function installSh(base: string): string {
  return INSTALL_SH.replaceAll("__BASE__", () => base);
}

/** `install.ps1` servi à un poste Windows sans session ; sondes HTTPS en GET (E35). */
export function installPs1(base: string): string {
  return INSTALL_PS1.replaceAll("__BASE__", () => base);
}
