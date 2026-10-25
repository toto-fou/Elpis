// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/carte-skin.ts — carte d'un bloc ```elpis-skin : vérification automatique par le serveur, aperçu, import, import et application, demande de correction ; le JSON du modèle n'entre jamais en HTML. */
import type { CorpsPerso, RapportPerso } from "@elpis/contracts";

import {
  analyserBlocSkin,
  demanderCorrection,
  importerSkin,
  libelleImport,
  messageBlocIllisible,
  messageCorrection,
  nomSkin,
  ouvrirApercuSkin,
  pastillesSkin,
  verifierSkin,
} from "../../reglages/skins-perso.ts";
import type { ResultatVerification } from "../../reglages/skins-perso.ts";

const CACHE_MAX = 50;
// Une vérification par contenu de bloc : les re-rendus du chat ne rappellent pas le serveur.
const verifications = new Map<string, Promise<ResultatVerification>>();

function verifierUneFois(texte: string, corps: CorpsPerso): Promise<ResultatVerification> {
  const connue = verifications.get(texte);
  if (connue) return connue;
  const p = verifierSkin(corps);
  if (verifications.size >= CACHE_MAX) verifications.delete(verifications.keys().next().value as string);
  verifications.set(texte, p);
  void p.then((r) => {
    if (!r.ok) verifications.delete(texte);
  });
  return p;
}

const CLASSE_PRIMAIRE = "skl-btn bg-blue-600 text-white hover:bg-blue-700";
const CLASSE_SECONDAIRE = "skl-btn skl-btn--secondary";

function el<K extends keyof HTMLElementTagNameMap>(
  balise: K,
  classe: string,
  texte = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(balise);
  e.className = classe;
  if (texte) e.textContent = texte;
  return e;
}

function bouton(libelle: string, icone: string, classe: string, clic: () => void): HTMLButtonElement {
  const b = el("button", classe);
  b.type = "button";
  const i = el("i", "ph " + icone);
  b.append(i, " " + libelle);
  b.onclick = clic;
  return b;
}

function liste(items: readonly string[], classe: string): HTMLUListElement {
  const ul = el("ul", "list-disc pl-5 text-xs space-y-0.5 " + classe);
  for (const t of items) ul.appendChild(el("li", "", t));
  return ul;
}

/** Remplace le `pre` par la carte et lance la vérification. */
export function carteSkin(pre: HTMLElement, rawText: string): void {
  const carte = el("div", "carte-skin rounded-xl border border-slate-200 bg-white p-3 mb-4 space-y-2");
  carte.setAttribute("data-carte-skin", "1");
  const tete = el("div", "flex items-center gap-2 flex-wrap");
  const pastilles = el("span", "inline-flex gap-0.5");
  const titre = el("strong", "text-sm text-slate-800", "Habillage");
  const etat = el("span", "text-xs text-slate-500", "Vérification…");
  etat.setAttribute("role", "status");
  tete.append(pastilles, titre, etat);
  const details = el("div", "space-y-1");
  const actions = el("div", "flex items-center gap-2 flex-wrap");
  const retour = el("div", "text-xs text-slate-600");
  retour.setAttribute("role", "status");
  carte.append(tete, details, actions, retour);
  pre.replaceWith(carte);

  const analyse = analyserBlocSkin(rawText);
  if (!analyse.ok) {
    etat.textContent = "Bloc illisible";
    details.appendChild(liste([analyse.erreur], "text-red-600"));
    actions.appendChild(
      bouton("Demander une correction", "ph-wrench", CLASSE_SECONDAIRE, () =>
        demanderCorrection(messageBlocIllisible(analyse.erreur)),
      ),
    );
    return;
  }
  const corps = analyse.corps;
  titre.textContent = nomSkin(corps);
  for (const c of pastillesSkin(corps)) {
    const p = el("span", "w-4 h-4 rounded-full border border-slate-300 inline-block");
    p.style.backgroundColor = c;
    pastilles.appendChild(p);
  }

  const importer = async (overwrite: boolean, appliquer: boolean): Promise<void> => {
    retour.textContent = "Import en cours…";
    const r = await importerSkin(corps, { overwrite, appliquer });
    retour.textContent = libelleImport(r);
    if (r.type === "existe")
      retour.appendChild(
        bouton(
          "Remplacer",
          "ph-arrows-clockwise",
          CLASSE_SECONDAIRE + " ml-2",
          () => void importer(true, appliquer),
        ),
      );
  };

  const monterResultat = (rapport: RapportPerso): void => {
    const n = rapport.erreurs.length;
    etat.textContent = n === 0 ? "✓ Valide" : `⚠ ${n} problème${n > 1 ? "s" : ""}`;
    etat.className = "text-xs font-medium " + (n === 0 ? "text-emerald-600" : "text-red-600");
    if (n) details.appendChild(liste(rapport.erreurs, "text-red-600"));
    if (rapport.avertissements.length) details.appendChild(liste(rapport.avertissements, "text-amber-600"));
    const importe = bouton(
      "Importer",
      "ph-download-simple",
      CLASSE_SECONDAIRE,
      () => void importer(false, false),
    );
    const applique = bouton(
      "Importer et appliquer",
      "ph-check",
      CLASSE_PRIMAIRE,
      () => void importer(false, true),
    );
    importe.disabled = applique.disabled = n > 0;
    actions.append(
      bouton("Prévisualiser", "ph-eye", CLASSE_SECONDAIRE, () => ouvrirApercuSkin(corps, rapport)),
      importe,
      applique,
    );
    if (n > 0)
      actions.appendChild(
        bouton("Demander une correction", "ph-wrench", CLASSE_SECONDAIRE, () =>
          demanderCorrection(messageCorrection(corps, rapport)),
        ),
      );
  };

  void verifierUneFois(rawText, corps).then((v) => {
    if (!carte.isConnected) return;
    if (!v.ok) {
      etat.textContent = "Non vérifié";
      details.appendChild(liste([v.message], "text-red-600"));
      return;
    }
    monterResultat(v.rapport);
  });
}
