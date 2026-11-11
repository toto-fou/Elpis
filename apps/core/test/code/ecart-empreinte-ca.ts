// SPDX-License-Identifier: MIT
/** apps/core/test/code/ecart-empreinte-ca.ts — écart voulu au Python : les installeurs de poste vérifient l'empreinte SHA-256 de la CA inscrite par le serveur ; script servi ramené à la forme du Python pour rejouer les vecteurs. */
import { INSTALL_PS1_PYTHON, INSTALL_SH_PYTHON } from "../../src/code/installeurs";

/** Bloc du gabarit de `debut` jusqu'à la fin de la ligne où `fin` se termine (comprise). */
function bloc(gabarit: string, debut: string, fin: string): string {
  const i = gabarit.indexOf(debut);
  const j = gabarit.indexOf(fin, i);
  if (i < 0 || j < 0) throw new Error(`bloc introuvable : ${debut}`);
  return gabarit.slice(i, gabarit.indexOf("\n", j + fin.length) + 1);
}

const REMPLACEMENTS: readonly [string, string][] = [
  [
    bloc(
      INSTALL_SH_PYTHON,
      "# Empreinte SHA-256 (hex, forme DER) inscrite par le serveur : seule une CA qui",
      "ca_matches() {",
    ),
    "",
  ],
  [bloc(INSTALL_SH_PYTHON, '      if ! ca_matches "$TMP/ca.crt"; then', "        continue\n      fi"), ""],
  [
    bloc(INSTALL_SH_PYTHON, '  *https://*)\n    if [ -z "$CA_SHA256" ]; then', "    fi ;;"),
    '  *https://*) fetch_ca || echo "⚠ CA locale introuvable (ni :80, ni /api/cli/ca.crt)." ;;\n',
  ],
  [
    bloc(
      INSTALL_PS1_PYTHON,
      "# Empreinte SHA-256 (hex, forme DER) inscrite par le serveur : sans elle",
      "} elseif (($AppUrl -like 'https://*') -or ($Base -like 'https://*')) {",
    ),
    "if (($AppUrl -like 'https://*') -or ($Base -like 'https://*')) {\n",
  ],
  [
    bloc(
      INSTALL_PS1_PYTHON,
      "        if ((Get-ElpisCaSha256 $CaDst) -eq $CaSha256.ToLower()) {",
      'Write-Host "Attention : CA recue de $u refusee',
    ),
    '        $CaFile = $CaDst; Write-Host "CA locale recuperee ($u) -> $CaDst"; break\n',
  ],
  [
    "CA locale introuvable ou non conforme a l'empreinte du serveur (ni :80, ni /api/cli/ca.crt).",
    "CA locale introuvable (ni :80, ni /api/cli/ca.crt).",
  ],
];

/** Script servi (bash ou PowerShell) sans la vérification d'empreinte : le texte du Python. */
export function sansEmpreinteCa(texte: string): string {
  let s = texte
    .replace(/^CA_SHA256="[0-9a-f]*"$/mu, 'CA_SHA256="__CA_SHA256__"')
    .replace(/^\$CaSha256 = '[0-9a-f]*'$/mu, "$CaSha256 = '__CA_SHA256__'");
  for (const [nouveau, ancien] of REMPLACEMENTS) s = s.split(nouveau).join(ancien);
  return s;
}
