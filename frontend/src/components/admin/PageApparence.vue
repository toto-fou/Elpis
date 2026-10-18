<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageApparence.vue — page Système › Apparence. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'appearance'" class="animate-[fadeIn_0.2s] space-y-6 min-w-0">
    <section id="skins" class="adm-card">
      <header class="adm-card__head">
        <i class="ph ph-palette adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">Skins</h3>
          <span class="sr-only">Habillages proposés aux comptes, skin par défaut, import et création.</span>
        </div>
        <div class="adm-card__actions">
          <input
            :ref="
              (el) => {
                adm.skinImportInput = el as typeof adm.skinImportInput;
              }
            "
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            @change="adm.skinImportFile"
          />
          <button
            type="button"
            class="adm-btn adm-tool adm-btn--sm"
            :disabled="adm.skinAdmBusy === '__import'"
            title="Paquet .zip : skin.json, skin.css, assets/ (png, jpg, webp, gif)"
            @click="adm.skinImportPick"
          >
            <i
              class="ph"
              :class="adm.skinAdmBusy === '__import' ? 'ph-spinner-gap animate-spin' : 'ph-upload-simple'"
              aria-hidden="true"
            ></i
            >Importer
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--primary adm-btn--sm"
            :disabled="!!adm.skinEd"
            @click="adm.skinNew"
          >
            <i class="ph ph-plus" aria-hidden="true"></i>Créer
          </button>
        </div>
      </header>

      <p v-if="adm.skinImportErr" class="adm-empty adm-empty--error px-5" role="alert">
        <i class="ph ph-warning" aria-hidden="true"></i> {{ adm.skinImportErr }}
      </p>

      <div v-if="adm.skinAdm.loading && !adm.skinAdm.loaded" class="adm-rows">
        <div v-for="n in 4" :key="'sks' + n" class="adm-row">
          <div class="adm-skeleton w-32"></div>
          <div class="adm-skeleton w-full"></div>
        </div>
      </div>
      <p v-else-if="adm.skinAdm.error" class="adm-empty adm-empty--error px-5">{{ adm.skinAdm.error }}</p>

      <table v-else class="adm-table">
        <thead>
          <tr>
            <th scope="col">Skin</th>
            <th scope="col">Source</th>
            <th scope="col">Actif</th>
            <th scope="col">Défaut</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="sk in adm.skinAdm.list" :key="'skn-' + (sk.id || 'ardoise')">
            <td>
              <div class="flex items-center gap-2.5 min-w-0" :title="sk.desc">
                <span
                  class="adm-swatch"
                  aria-hidden="true"
                  :style="{ '--sw-rail': sk.sw[0], '--sw-bg': sk.sw[1], '--sw-acc': sk.sw[2] }"
                ></span>
                <span class="font-medium truncate">{{ sk.label }}</span>
                <span v-if="sk.brand" class="adm-tag adm-tag--soft" title="Renomme l'assistant">{{
                  sk.brand.name
                }}</span>
              </div>
            </td>
            <td>
              <span
                class="adm-tag adm-tag--soft"
                :title="
                  sk.source === 'plugin'
                    ? [sk.version, sk.author, sk.license].filter(Boolean).join(' · ')
                    : 'Livré avec Elpis'
                "
                >{{ sk.source === "plugin" ? "Importé" : "Intégré" }}</span
              >
            </td>
            <td>
              <label
                class="relative inline-flex items-center cursor-pointer w-fit"
                :class="sk.locked ? 'opacity-50 cursor-not-allowed' : ''"
                :title="
                  sk.locked
                    ? sk.id === ''
                      ? 'Ardoise reste toujours disponible'
                      : 'Le skin par défaut reste actif'
                    : sk.enabled
                      ? 'Proposé aux comptes'
                      : 'Masqué aux comptes'
                "
              >
                <input
                  type="checkbox"
                  class="sr-only peer"
                  :checked="sk.enabled"
                  :disabled="sk.locked || adm.skinAdmBusy === sk.id"
                  :aria-label="'Activer ' + sk.label"
                  @change="adm.skinToggle(sk)"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
              </label>
            </td>
            <td>
              <span v-if="sk.is_default" class="adm-tag" title="Skin des comptes qui n'ont rien choisi"
                >Défaut</span
              >
              <button
                v-else
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                :title="'Définir « ' + sk.label + ' » par défaut (l\'active)'"
                :disabled="adm.skinAdmBusy === sk.id"
                @click="adm.skinSetDefault(sk)"
              >
                Définir
              </button>
            </td>
            <td class="text-right whitespace-nowrap">
              <button
                v-if="sk.source === 'plugin'"
                type="button"
                class="adm-btn adm-btn--icon"
                title="Modifier"
                :aria-label="'Modifier ' + sk.label"
                :disabled="!!adm.skinEd"
                @click="adm.skinEdit(sk)"
              >
                <i class="ph ph-pencil-simple" aria-hidden="true"></i>
              </button>
              <button
                v-if="sk.id !== ''"
                type="button"
                class="adm-btn adm-btn--icon"
                title="Exporter (.zip)"
                :aria-label="'Exporter ' + sk.label"
                @click="adm.skinExport(sk)"
              >
                <i class="ph ph-download-simple" aria-hidden="true"></i>
              </button>
              <button
                v-if="sk.source === 'plugin'"
                type="button"
                class="adm-btn adm-btn--icon adm-btn--icon-danger"
                title="Supprimer"
                :aria-label="'Supprimer ' + sk.label"
                :disabled="sk.is_default || adm.skinAdmBusy === sk.id"
                @click="adm.skinDelete(sk)"
              >
                <i class="ph ph-trash" aria-hidden="true"></i>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="adm.skinEd" id="skin-editor" class="adm-card">
      <header class="adm-card__head">
        <i class="ph ph-paint-brush adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">
            {{ adm.skinEd.mode === "edit" ? "Modifier « " + adm.skinEd.label + " »" : "Nouveau skin" }}
          </h3>
        </div>
        <div class="adm-card__actions">
          <button
            type="button"
            class="adm-btn adm-btn--quiet adm-btn--sm"
            :disabled="adm.skinEd.saving"
            @click="adm.skinEdClose"
          >
            Annuler
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--primary adm-btn--sm"
            :disabled="adm.skinEd.saving"
            @click="adm.skinEdSave"
          >
            <i
              class="ph"
              :class="adm.skinEd.saving ? 'ph-spinner-gap animate-spin' : 'ph-floppy-disk'"
              aria-hidden="true"
            ></i
            >Enregistrer
          </button>
        </div>
      </header>

      <div class="skn-ed">
        <div class="space-y-4 min-w-0">
          <div class="skn-form">
            <label class="skn-form__lbl" for="skn-id" title="Minuscules, chiffres, - ou _ (2 à 32)."
              >Identifiant</label
            >
            <input
              id="skn-id"
              v-model.trim="adm.skinEd.id"
              class="set-input"
              :disabled="adm.skinEd.mode === 'edit'"
              maxlength="32"
              placeholder="mon-skin"
              spellcheck="false"
              autocomplete="off"
            />
            <label class="skn-form__lbl" for="skn-label">Nom</label>
            <input
              id="skn-label"
              v-model="adm.skinEd.label"
              class="set-input"
              maxlength="40"
              placeholder="Mon skin"
            />
            <label class="skn-form__lbl" for="skn-desc">Description</label>
            <input id="skn-desc" v-model="adm.skinEd.description" class="set-input" maxlength="200" />
            <template v-if="adm.skinEd.mode === 'create'">
              <label class="skn-form__lbl" for="skn-base" title="Jetons de départ, lus sur ce skin."
                >Base</label
              >
              <select
                id="skn-base"
                class="set-select"
                :value="adm.skinEd.base"
                @change="adm.skinEdBase(($event.target as HTMLInputElement).value)"
              >
                <option v-for="b in adm.skinBases" :key="'skb-' + (b.id || 'ardoise')" :value="b.id">
                  {{ b.label }}
                </option>
              </select>
            </template>
            <label
              class="skn-form__lbl"
              for="skn-brand"
              title="Renomme l'assistant quand ce skin est actif (sauf nom personnalisé)."
              >Marque</label
            >
            <input
              id="skn-brand"
              v-model="adm.skinEd.brand"
              class="set-input"
              maxlength="40"
              placeholder="Elpis"
            />
            <span class="skn-form__lbl">Pastilles</span>
            <div class="flex items-center gap-2">
              <input
                v-for="(c, i) in adm.skinEd.swatch"
                :key="'sw' + i"
                type="color"
                class="skn-color"
                :value="adm.skinHex(c)"
                :aria-label="['Pastille rail', 'Pastille fond', 'Pastille accent'][i]"
                :title="['Rail', 'Fond', 'Accent'][i]"
                @input="adm.skinEd.swatch[i] = ($event.target as HTMLInputElement).value"
              />
              <label
                class="inline-flex items-center gap-1.5 text-xs text-slate-600 ml-2 cursor-pointer"
                title="Le mode clair de ce skin est déjà sombre (active les ajustements sur fond sombre)."
              >
                <input
                  v-model="adm.skinEd.darkBase"
                  type="checkbox"
                  class="rounded border-slate-300 text-blue-600"
                />Base sombre
              </label>
            </div>
          </div>

          <div>
            <div class="flex items-center gap-3 mb-2">
              <span class="text-xs font-medium text-slate-600">Jetons</span>
              <div class="adm-seg adm-seg--sm" role="radiogroup" aria-label="Mode édité">
                <button
                  v-for="m in [
                    { v: 'light', l: 'Clair' },
                    { v: 'dark', l: 'Sombre' },
                  ]"
                  :key="'skm-' + m.v"
                  type="button"
                  role="radio"
                  :aria-checked="adm.skinEd.view === m.v ? 'true' : 'false'"
                  class="adm-seg__btn"
                  :class="adm.skinEd.view === m.v ? 'is-active' : ''"
                  @click="adm.skinEd.view = m.v"
                >
                  {{ m.l }}
                </button>
              </div>
              <span
                v-if="adm.skinEdExtraCount"
                class="text-[11px] text-slate-400"
                title="Autres jetons du skin de départ, recopiés tels quels."
                >+ {{ adm.skinEdExtraCount }} repris</span
              >
            </div>
            <div class="skn-toks">
              <div v-for="t in adm.SKIN_TOKENS" :key="'skt-' + t.k" class="skn-tok">
                <label class="skn-tok__lbl" :for="'skt-' + t.k" :title="t.k">{{ t.l }}</label>
                <input
                  v-if="t.color !== false"
                  type="color"
                  class="skn-color"
                  :value="adm.skinHex(adm.skinEd.tokens[adm.skinEd.view][t.k])"
                  :aria-label="t.l + ' (couleur)'"
                  @input="adm.skinEd.tokens[adm.skinEd.view][t.k] = ($event.target as HTMLInputElement).value"
                />
                <input
                  :id="'skt-' + t.k"
                  v-model="adm.skinEd.tokens[adm.skinEd.view][t.k]"
                  class="set-input skn-tok__val"
                  spellcheck="false"
                  autocomplete="off"
                  maxlength="200"
                />
              </div>
            </div>
          </div>

          <details class="skn-css">
            <summary class="text-xs font-medium text-slate-600 cursor-pointer">CSS avancé</summary>
            <textarea
              v-model="adm.skinEd.css"
              rows="8"
              class="set-textarea font-mono text-xs mt-2"
              spellcheck="false"
              placeholder=".elpis-skin-self .elpis-compose-card { box-shadow: none; }"
              title="Sélecteur .elpis-skin-self = ce skin. Images : url(assets/…) d'un paquet importé ou data:image. Pas de @import ni d'URL externe."
            ></textarea>
          </details>

          <p v-if="adm.skinEd.error" class="adm-empty adm-empty--error" role="alert">
            <i class="ph ph-warning" aria-hidden="true"></i> {{ adm.skinEd.error }}
          </p>
        </div>

        <div class="skn-ed__side">
          <div class="skn-prev" :style="adm.skinPreviewStyle" role="img" aria-label="Aperçu du skin">
            <div class="skn-prev__rail">
              <span class="skn-prev__brand">{{ adm.skinEd.brand || "Elpis" }}</span>
              <span class="skn-prev__item skn-prev__item--on">Conversation</span>
              <span class="skn-prev__item">Sandbox</span>
              <span class="skn-prev__item">Routines</span>
            </div>
            <div class="skn-prev__main">
              <div class="skn-prev__word" aria-hidden="true">
                <span class="skn-prev__ink">EL</span><span class="skn-prev__clay">P</span
                ><span class="skn-prev__ink">IS</span> <span class="skn-prev__mute">accueil</span>
              </div>
              <div class="skn-prev__bubble">Résume ce fichier.</div>
              <div class="skn-prev__card">
                <div class="skn-prev__title">Réponse</div>
                <div class="skn-prev__sub">Texte courant et <span class="skn-prev__link">un lien</span>.</div>
                <div class="skn-prev__muted">Texte discret</div>
              </div>
              <div class="skn-prev__chips">
                <span class="skn-prev__chip skn-prev__chip--ok">OK</span>
                <span class="skn-prev__chip skn-prev__chip--warn">Alerte</span>
                <span class="skn-prev__chip skn-prev__chip--danger">Erreur</span>
              </div>
              <span class="skn-prev__btn">Envoyer</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
