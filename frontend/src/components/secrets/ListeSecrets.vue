<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/ListeSecrets.vue — Paramètres › Secrets › Secrets web : un bloc par secret, comme les Comptes Git et les jetons (nom et états, type, identifiant, dernier usage, sites), actions à droite (vérifier, rotation, modifier, renvoi au connecteur, suppression confirmée sur le même bouton), panneau dans le bloc, focus rendu après chaque action. -->
<script setup lang="ts">
import type { Secret } from "@elpis/contracts";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { porteeTexte } from "../../features/secrets/format";
import { domaineSecrets } from "../../features/secrets/gestion";
import {
  infoNom,
  infoUsage,
  morceaux,
  partiesSite,
  quand,
  sitesRepliables,
  usages,
} from "../../features/secrets/presentation";
import PanneauSecret from "./PanneauSecret.vue";

const g = domaineSecrets();
const racine = ref<HTMLElement | null>(null);
const { deplies, repliable, sitesMontres, sitesCaches, basculerSites } = sitesRepliables();

// Table littérale : une classe d'icône composée à la volée serait absente de la feuille générée.
const ICONES: Readonly<Record<string, string>> = {
  "web-login": "ph-globe",
  "http-auth": "ph-globe",
  token: "ph-key",
  git: "ph-git-branch",
};
const icone = (s: Secret): string => ICONES[s.kind] ?? "ph-vault";

const BOUTON =
  "w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0";

/** Premier bouton d'action d'un bloc : là où le focus revient. */
function actions(id: number | null | undefined): HTMLElement | null {
  if (id === null || id === undefined) return null;
  return racine.value?.querySelector<HTMLElement>(`[data-actions="${id}"] button:not(:disabled)`) ?? null;
}

/** Blocs voisins d'un bloc, lus avant la mise à jour du DOM (un bloc supprimé n'y est plus après). */
function voisins(id: number): { suivant?: number; precedent?: number } {
  const ids = [...(racine.value?.querySelectorAll<HTMLElement>("[data-secret-id]") ?? [])].map((e) =>
    Number(e.dataset["secretId"]),
  );
  const i = ids.indexOf(id);
  return i < 0 ? {} : { suivant: ids[i + 1], precedent: ids[i - 1] };
}

/** Focus rendu aux actions du bloc, à celles d'un voisin s'il a disparu, sinon à la liste. */
function rendreFocus(id: number, v: { suivant?: number; precedent?: number }): void {
  (actions(id) ?? actions(v.suivant) ?? actions(v.precedent) ?? racine.value)?.focus();
}

const focusPerdu = (actif: Element | null): boolean => !actif || actif === globalThis.document.body;

// Suppression armée puis clic ailleurs que sur les actions de ce bloc : désarmée.
function dehors(e: Event): void {
  if (g.confirmer === null || !(e.target instanceof Node)) return;
  if (!racine.value?.querySelector(`[data-actions="${g.confirmer}"]`)?.contains(e.target))
    g.annulerSuppression();
}
onMounted(() => globalThis.document.addEventListener("pointerdown", dehors, true));
onBeforeUnmount(() => {
  globalThis.document.removeEventListener("pointerdown", dehors, true);
  g.reinitialiserVue();
});

// Suppression armée : annoncée aux lecteurs d'écran, et dite sous le bloc.
const annonce = computed(() => {
  const s = g.secrets.find((x) => x.id === g.confirmer);
  return s ? `« ${s.name} » : cliquez de nouveau sur Supprimer pour confirmer.` : "";
});
const idAnnonce = `secrets-confirmation-${g.portee}`;

/** Le même bouton arme puis supprime ; le bloc disparu, le focus va à un voisin. */
async function supprimer(id: number): Promise<void> {
  const autour = voisins(id);
  await g.clicSupprimer(id);
  await nextTick();
  if (!g.secrets.some((s) => s.id === id)) rendreFocus(id, autour);
}

// Panneau ouvert : focus sur son premier champ ou bouton ; refermé avec le focus dedans, focus rendu aux actions du bloc.
watch(
  () => g.panneau,
  async (p, avant) => {
    const actif = globalThis.document.activeElement;
    const dedans = focusPerdu(actif) || !!actif?.closest("[data-panneau]");
    const autour = avant ? voisins(avant.id) : {};
    await nextTick();
    if (p)
      racine.value
        ?.querySelector<HTMLElement>(
          `[data-panneau="${p.id}"] input, [data-panneau="${p.id}"] button:not(:disabled)`,
        )
        ?.focus();
    else if (avant && dedans) rendreFocus(avant.id, autour);
  },
);
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div
    ref="racine"
    class="elpis-secrets space-y-2"
    tabindex="-1"
    :data-secrets-portee="g.portee"
    :aria-busy="g.chargement ? 'true' : undefined"
  >
    <p :id="idAnnonce" class="sr-only" role="status">{{ annonce }}</p>
    <p v-if="g.erreurListe" role="alert" class="elpis-secrets__refus">{{ g.erreurListe }}</p>
    <p v-else-if="g.chargement && !g.charge" class="text-sm text-slate-500 py-4 text-center">Chargement…</p>
    <p v-else-if="g.charge && !g.secrets.length" class="text-sm text-slate-500 py-4 text-center">
      Aucun secret.
    </p>
    <div
      v-for="s in g.secrets"
      :key="s.id"
      class="border border-slate-200 rounded-xl p-3.5"
      :data-secret="s.name"
      :data-secret-id="s.id"
    >
      <div class="flex items-start gap-3">
        <i class="ph text-lg text-slate-400 shrink-0" :class="icone(s)" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 elpis-secret-bloc__nom" :title="infoNom(s)">
            <span data-nom>{{ s.name }}</span>
            <span
              v-if="s.state === 'unverified'"
              class="elpis-secrets__etat font-normal"
              title="Importé : inutilisable avant vérification"
              >à vérifier</span
            >
            <span
              v-if="s.policy.tls === 'insecure'"
              class="elpis-secrets__etat font-normal"
              title="Certificat TLS non vérifié pour ce secret"
              >TLS non vérifié</span
            >
            <span
              v-if="!s.key_current"
              class="elpis-secrets__etat elpis-secrets__etat--cle font-normal"
              title="Chiffré par une autre clé que la clé courante : rotation, ou ./elpis vault rekey"
              >autre clé</span
            >
          </div>
          <div class="text-xs text-slate-500 elpis-secret-bloc__resume" data-resume>
            <span data-type>{{ s.kind }}</span> ·
            <span title="+1 à chaque rotation" data-version>v{{ s.version }}</span>
            <template v-if="s.username">
              · <span class="text-slate-700" data-identifiant>{{ s.username }}</span></template
            >
            ·
            <span :title="infoUsage(s)" data-dernier>{{
              s.last_used_at ? `utilisé ${quand(s)}` : "jamais utilisé"
            }}</span
            ><template v-if="s.use_count">
              · <span data-usages>{{ usages(s) }}</span></template
            >
          </div>
          <ul
            v-if="porteeTexte(s).length"
            :id="`secret-sites-${s.id}`"
            class="elpis-secrets__sites font-mono text-xs mt-1.5"
            :aria-label="`Sites de ${s.name}`"
          >
            <li v-for="o in sitesMontres(s)" :key="o" class="elpis-secrets__site">
              <span class="elpis-secrets__schema">{{ partiesSite(o)[0] }}</span
              ><template v-for="(m, n) in morceaux(partiesSite(o)[1])" :key="n"
                ><wbr v-if="n" />{{ m }}</template
              >
            </li>
          </ul>
          <button
            v-if="repliable(s)"
            type="button"
            class="elpis-secrets__plus"
            :aria-expanded="deplies.has(s.id) ? 'true' : 'false'"
            :aria-controls="`secret-sites-${s.id}`"
            :aria-label="
              deplies.has(s.id)
                ? `Réduire les sites de ${s.name}`
                : `Sites de ${s.name} : ${sitesCaches(s)} autres`
            "
            data-plus-sites
            @click="basculerSites(s.id)"
          >
            {{ deplies.has(s.id) ? "réduire" : `+ ${sitesCaches(s)} autres` }}
          </button>
        </div>
        <div class="flex items-center gap-1 shrink-0" :data-actions="s.id">
          <button
            v-if="g.droits(s).verification"
            type="button"
            title="Rendre utilisable ce secret importé, après relecture de ce pour quoi il sert"
            class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
            data-action="verifier"
            @click="g.choisir(s.id, 'verifier')"
          >
            Vérifier
          </button>
          <button
            v-if="g.droits(s).rotation"
            type="button"
            title="Rotation : nouvelle valeur, version + 1"
            :aria-label="`Rotation de ${s.name}`"
            :class="BOUTON"
            data-action="rotation"
            @click="g.choisir(s.id, 'rotation')"
          >
            <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
          </button>
          <button
            v-if="g.droits(s).modification"
            type="button"
            title="Modifier"
            :aria-label="`Modifier ${s.name}`"
            :class="BOUTON"
            data-action="modifier"
            @click="g.choisir(s.id, 'modifier')"
          >
            <i class="ph ph-pencil-simple" aria-hidden="true"></i>
          </button>
          <button
            v-if="g.droits(s).gere"
            type="button"
            :title="g.droits(s).gere?.libelle"
            :aria-label="`${g.droits(s).gere?.libelle} : ${s.name}`"
            :class="BOUTON"
            data-action="gerer"
            @click="g.choisir(s.id, 'gerer')"
          >
            <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
          </button>
          <button
            v-if="g.droits(s).suppression"
            type="button"
            :title="g.confirmer === s.id ? 'Cliquez de nouveau pour supprimer' : 'Supprimer'"
            :aria-label="`Supprimer ${s.name}`"
            :aria-describedby="g.confirmer === s.id ? idAnnonce : undefined"
            class="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
            :class="
              g.confirmer === s.id
                ? 'is-arme bg-red-50 text-red-600'
                : 'text-slate-500 hover:bg-red-50 hover:text-red-600'
            "
            :disabled="g.occupe"
            data-action="supprimer"
            @click="supprimer(s.id)"
          >
            <i class="ph ph-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <p
        v-if="g.confirmer === s.id"
        class="mt-2 flex items-center justify-end gap-2 text-xs text-red-600"
        data-confirmation
      >
        <span aria-hidden="true">Cliquez de nouveau sur la corbeille pour supprimer.</span>
        <button
          type="button"
          class="px-2 py-1 rounded-md text-slate-600 hover:bg-slate-100"
          @click="g.annulerSuppression()"
        >
          Annuler
        </button>
      </p>
      <div
        v-if="g.panneau?.id === s.id || g.erreur?.cible === s.id"
        class="mt-3 pt-3 border-t border-slate-200"
        :data-panneau="s.id"
      >
        <PanneauSecret :secret="s" />
      </div>
    </div>
  </div>
</template>
