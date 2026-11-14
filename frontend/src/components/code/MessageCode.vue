<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/code/MessageCode.vue — une ligne du transcript opencode (note de commande ou message et ses parts) ; ses détails dépliés lui sont propres, une bascule ne re-rend qu'elle ; ses parts texte en flux sont des corps Markdown du chat rendus par blocs, celles d'un message déjà fini un rendu complet en cache. -->
<script setup lang="ts">
import { reactive } from "vue";

import { planifierBalayage } from "../../features/chat/rendu/coloration";
import type { EtatFlux } from "../../features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../features/chat/rendu/instance";
import { domaineCode } from "../../features/code/domaine";
import type { MessageOpencode } from "../../features/code/rendu";
import ContenuMarkdown from "../chat/ContenuMarkdown.vue";
import type { MessageMarkdown } from "../chat/ContenuMarkdown.vue";
import LibelleVivant from "../communs/LibelleVivant.vue";
import CarteDiff from "./CarteDiff.vue";

defineProps<{ m: MessageOpencode; live: boolean }>();

const cd = domaineCode();
const moteur = moteurMarkdown();
const ouverts = reactive<Record<string, boolean>>({});
const reflexions = reactive<Record<string, boolean>>({});
const corps = new Map<string, MessageMarkdown>();

/** Corps d'une part texte, comme un message du chat : découpe reprise d'une mise à jour à l'autre, blocs gardés à la fin ; même objet tant que rien ne change. */
function corpsDe(id: string, texte: string, vivant: boolean): MessageMarkdown {
  const avant = corps.get(id);
  if (avant?.content === texte && !!avant.isStreaming === vivant) return avant;
  const etat = (avant?._mdFlux as EtatFlux | null | undefined) ?? null;
  const r = vivant ? moteur.avancerFlux(texte, etat) : etat && moteur.terminerFlux(texte, etat);
  const neuf: MessageMarkdown = r
    ? {
        content: texte,
        isStreaming: vivant,
        _mdBlocks: r.etat.blocs,
        _mdActiveHtml: r.actifHtml,
        _mdFlux: r.etat,
      }
    : { content: texte };
  corps.set(id, neuf);
  return neuf;
}

/** Part d'un message déjà fini à sa lecture : rendu complet en cache, colorée au repos. */
function htmlFini(texte: string): string {
  planifierBalayage();
  return moteur.renderMarkdown(texte);
}

function basculer(id: string): void {
  ouverts[id] = !ouverts[id];
}
/** Ouvrir une réflexion en cours mène à sa fin, d'où elle suit le texte. */
function surReflexion(id: string, enCours: boolean, ev: Event): void {
  const details = ev.target as HTMLDetailsElement;
  reflexions[id] = details.open;
  const pre = details.open && enCours ? details.querySelector("pre") : null;
  if (pre) pre.scrollTop = pre.scrollHeight;
}
</script>

<!-- eslint-disable vue/no-v-html -- Markdown du transcript rendu par le moteur du chat (purifié par DOMPurify). -->
<template>
  <div class="flex gap-3" :class="m.role === 'user' ? 'flex-row-reverse' : ''">
    <!-- Trace de commande (« ce qui a été fait » : /cmd, /undo…) — pill centrée persistante, posée par l'app à l'envoi -->
    <div v-if="m.role === 'note'" class="flex-1 flex justify-center py-0.5">
      <span
        class="inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 rounded-full border text-[11px] font-mono"
        :class="
          m.info.note && m.info.note.kind === 'error'
            ? 'elpis-code-tool-err border-transparent'
            : 'bg-slate-50 border-slate-200 text-slate-500'
        "
        :title="(m.info.note && m.info.note.detail) || ''"
      >
        <i
          class="ph text-slate-400"
          style="font-size: 11px"
          :class="m.info.note && m.info.note.kind === 'error' ? 'ph-warning-circle' : 'ph-terminal'"
        ></i>
        <span class="font-semibold shrink-0">{{ m.info.note ? m.info.note.label : "" }}</span>
        <span v-if="m.info.note && m.info.note.detail" class="truncate max-w-[16rem] text-slate-400">{{
          m.info.note.detail
        }}</span>
      </span>
    </div>

    <template v-else>
      <!-- Avatars : MÊMES que le chat principal (photo user, logo de l'application pour l'assistant) — cohérence -->
      <div class="shrink-0 mt-0.5">
        <div v-if="m.role === 'user'">
          <img
            v-if="cd.user?.avatar"
            :src="'/avatars/' + cd.user.avatar"
            class="w-9 h-9 rounded-full object-cover border border-slate-200 shadow-sm"
            :class="m.pending ? 'opacity-60' : ''"
          />
          <div
            v-else
            class="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold border border-slate-200"
            :class="m.pending ? 'opacity-60' : ''"
          >
            <i class="ph ph-user text-lg"></i>
          </div>
        </div>
        <img
          v-else
          :src="cd.logoApp"
          alt=""
          data-avatar-assistant
          class="w-9 h-9 rounded-full object-cover shadow-sm border border-slate-200"
        />
      </div>
      <div
        class="min-w-0 flex-1 flex flex-col gap-1.5"
        :class="m.role === 'user' ? 'items-end' : 'items-start'"
      >
        <!-- Message de compaction : opencode le marque `summary`, il ne raconte pas le tour mais le résume -->
        <span
          v-if="m.info && m.info.summary"
          class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-[10.5px] text-slate-500"
        >
          <i class="ph ph-arrows-in-line-horizontal" style="font-size: 10px"></i>Résumé
        </span>

        <!-- Erreur du tour, telle que la CLI la rapporte -->
        <div
          v-if="m.info && m.info.error && cd.codeMsgError(m)"
          class="elpis-error-card w-full rounded-xl px-3 py-2 flex items-start gap-2"
        >
          <i class="ph ph-warning-circle shrink-0 mt-0.5" style="font-size: 13px"></i>
          <div class="min-w-0">
            <div class="elpis-error-title text-[11.5px] font-semibold">
              {{ cd.codeMsgError(m)?.name }}
            </div>
            <div v-if="cd.codeMsgError(m)?.message" class="text-[11px] break-words whitespace-pre-wrap">
              {{ cd.codeMsgError(m)?.message }}
            </div>
          </div>
        </div>

        <template v-for="item in cd.codeSteps(m, live)" :key="item.id">
          <!-- Texte user : bulle (écho optimiste = horloge + opacité réduite) -->
          <div
            v-if="item.kind === 'text' && m.role === 'user'"
            class="max-w-full rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words text-left bg-blue-600 text-white"
            :class="m.pending ? 'opacity-60' : ''"
          >
            <i v-if="m.pending" class="ph ph-clock mr-1.5 opacity-80"></i>{{ item.text }}
          </div>

          <!-- Texte assistant en flux, ou vu en flux : corps Markdown du chat (blocs figés gardés, même purification) ; un bloc de code reste du code, coloré -->
          <ContenuMarkdown
            v-else-if="item.kind === 'text' && !item.heavy && (item.live || corps.has(item.id))"
            class="w-full text-left"
            coloration-seule
            :msg="corpsDe(item.id, item.text, !!item.live)"
          />
          <!-- Texte d'un message déjà fini à sa lecture : rendu complet en cache, sans composant par part -->
          <div
            v-else-if="item.kind === 'text' && !item.heavy"
            class="w-full text-left markdown-body"
            v-html="htmlFini(item.text)"
          ></div>
          <div
            v-else-if="item.kind === 'text'"
            class="w-full text-sm whitespace-pre-wrap break-words text-left text-slate-800"
          >
            {{ item.text }}
          </div>

          <!-- Bloc ```diff du texte assistant : mêmes cartes que les diffs d'outils (au lieu d'un bloc code markdown) -->
          <CarteDiff v-else-if="item.kind === 'diff'" :cid="item.id" :text="item.text"></CarteDiff>

          <!-- Activité en cours : UN seul signal, dans la colonne du message que la CLI est en train d'écrire — donc aligné -->
          <div
            v-else-if="item.kind === 'status'"
            data-code-status
            role="status"
            aria-live="polite"
            class="flex items-center gap-2 text-[12px] text-slate-500"
          >
            <span class="elpis-typing"><span></span><span></span><span></span></span>
            <LibelleVivant :texte="item.phase" />
            <span v-if="cd.codeElapsed(item.since)" class="font-mono text-[11px] text-slate-400 tabular-nums"
              >· {{ cd.codeElapsed(item.since) }}</span
            >
          </div>

          <!-- Thinking : replié par défaut, libellé animé (.mem-wave) pendant l'activité ; déplié, il suit le texte si on le lit jusqu'au bas -->
          <details
            v-else-if="item.kind === 'think'"
            data-code-think
            :open="!!reflexions[item.id]"
            class="group/think w-full"
            @toggle="surReflexion(item.id, !item.done, $event)"
          >
            <summary
              class="list-none flex items-center gap-1.5 cursor-pointer select-none w-fit py-0.5 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <i class="ph ph-brain text-slate-400" style="font-size: 11px"></i>
              <LibelleVivant class="text-[12.5px] font-semibold" :vivant="!item.done" texte="Thinking..." />
              <span v-if="item.meta" class="text-[11px] font-mono text-slate-400 font-normal tabular-nums"
                >· {{ item.meta }}</span
              >
              <i
                class="ph ph-caret-right text-slate-300 transition-transform group-open/think:rotate-90"
                style="font-size: 9px"
              ></i>
            </summary>
            <div class="mt-1 pl-3 border-l-2 border-slate-200 ml-0.5">
              <pre
                class="text-[11.5px] text-slate-600 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-52 overflow-y-auto custom-scrollbar m-0 bg-transparent"
                >{{ item.text }}</pre>
            </div>
          </details>

          <!-- Appel d'outil — la ligne du TUI : icône d'état, nom de l'outil, SUJET réel -->
          <div v-else-if="item.kind === 'tool'" class="w-full">
            <!-- Ligne entière cliquable quand il y a un détail (la pastille l'était) -->
            <div
              class="elpis-code-tool-row"
              :class="[
                item.error ? 'elpis-code-tool-err' : '',
                item.hasDetail ? 'elpis-code-tool-row-btn' : '',
              ]"
              @click="item.hasDetail && basculer(item.id)"
            >
              <i v-if="item.running" class="ph ph-spinner-gap animate-spin text-blue-500 shrink-0"></i>
              <i v-else-if="item.error" class="ph ph-x-circle shrink-0"></i>
              <img
                v-else-if="item.icon === 'ph-robot'"
                :src="cd.logoApp"
                alt=""
                data-logo-sous-agent
                class="w-4 h-4 rounded-full object-cover shrink-0"
              />
              <i v-else class="ph shrink-0 text-slate-400" :class="item.icon"></i>
              <span
                class="font-mono text-[12px] font-semibold shrink-0"
                :class="item.running ? 'text-blue-600' : ''"
                >{{ item.tool }}</span
              >
              <span v-if="item.subject" class="font-mono text-[11.5px] text-slate-500 truncate">{{
                item.subject
              }}</span>
              <span v-else class="text-[11px] text-slate-400 shrink-0">{{
                cd.codeToolLabel(item.status)
              }}</span>
              <span
                v-if="item.metric"
                class="ml-auto pl-2 font-mono text-[11px] tabular-nums shrink-0"
                :class="item.metricTone || 'text-slate-400'"
                >{{ item.metric }}</span
              >
              <button
                v-if="item.hasDetail"
                :title="ouverts[item.id] ? 'Masquer le détail' : 'Paramètres et sortie'"
                :class="item.metric ? '' : 'ml-auto'"
                class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                @click.stop="basculer(item.id)"
              >
                <i
                  class="ph ph-caret-down transition-transform"
                  :class="ouverts[item.id] ? 'rotate-180' : ''"
                  style="font-size: 9px"
                ></i>
              </button>
            </div>

            <!-- Erreur d'outil : jamais repliée -->
            <pre
              v-if="item.errText"
              class="elpis-code-tool-errtext mt-1.5 mb-0 ml-2 mr-0 text-[11px] whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto custom-scrollbar bg-transparent"
              >{{ item.errText }}</pre>

            <!-- todowrite : la liste elle-même, comme le TUI -->
            <ul v-if="item.todos" class="mt-1.5 ml-2 space-y-0.5">
              <li
                v-for="(t, ti) in item.todos"
                :key="ti"
                class="flex items-start gap-1.5 text-[11.5px]"
                :class="t.status === 'completed' ? 'text-slate-400' : 'text-slate-600'"
              >
                <i
                  class="ph shrink-0 mt-0.5"
                  style="font-size: 11px"
                  :class="
                    t.status === 'completed'
                      ? 'ph-check-square'
                      : t.status === 'in_progress'
                        ? 'ph-arrow-right'
                        : 'ph-square'
                  "
                ></i>
                <span :class="t.status === 'completed' ? 'line-through' : ''">{{ t.text }}</span>
              </li>
            </ul>

            <transition name="tool-detail">
              <div
                v-if="ouverts[item.id]"
                class="mt-2 rounded-xl border border-slate-200 bg-white/60 shadow-sm text-[11px] overflow-hidden"
              >
                <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60">
                  <i class="ph ph-terminal-window text-slate-400"></i>
                  <span class="font-mono font-semibold text-slate-700">{{ item.tool }}</span>
                  <span class="text-slate-400"
                    >{{ cd.codeToolLabel(item.status) }}<span v-if="item.dur"> · {{ item.dur }}</span></span
                  >
                  <button
                    title="Fermer"
                    class="ml-auto w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                    @click="basculer(item.id)"
                  >
                    <i class="ph ph-x" style="font-size: 10px"></i>
                  </button>
                </div>
                <div v-if="item.input" class="px-3 py-2 border-b border-slate-100">
                  <div class="text-xs font-semibold text-slate-500 mb-1">Paramètres</div>
                  <div class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 font-mono">
                    <template v-for="(v, k) in item.input" :key="k">
                      <span class="text-slate-400">{{ k }}</span>
                      <span class="text-slate-700 break-all whitespace-pre-wrap">{{ cd.codeFmtVal(v) }}</span>
                    </template>
                  </div>
                </div>
                <div class="px-3 py-2">
                  <div class="text-xs font-semibold text-slate-500 mb-1">Résultat</div>
                  <!-- Sortie qui EST un diff (ex. bash git diff) : cartes colorisées au lieu du <pre> brut -->
                  <div v-if="item.outDiff && !item.errText" class="max-h-64 overflow-y-auto custom-scrollbar">
                    <CarteDiff :cid="item.id + ':out'" :text="item.outDiff"></CarteDiff>
                  </div>
                  <pre
                    v-else-if="item.errText || item.output"
                    class="m-0 whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto custom-scrollbar bg-transparent"
                    :class="item.errText ? 'elpis-code-tool-errtext' : 'text-slate-600'"
                    >{{ item.errText || item.output }}</pre>
                  <div v-else-if="item.running" class="flex items-center gap-1.5 text-slate-400">
                    <i class="ph ph-circle-notch animate-spin"></i> en cours…
                  </div>
                  <div v-else class="text-slate-400">—</div>
                </div>
              </div>
            </transition>

            <!-- Diff de l'outil (edit, write, patch) : TOUJOURS visible, jamais derrière un clic — c'est le résultat du tour. -->
            <div v-if="item.diff" class="mt-2 w-full">
              <CarteDiff :cid="item.id" :text="item.diff"></CarteDiff>
            </div>
          </div>

          <!-- Séparateur d'étape (les tokens par étape sont retirés : la jauge ctx du header porte l'info) -->
          <div v-else-if="item.kind === 'step'" aria-hidden="true" class="w-full flex items-center py-0.5">
            <span class="flex-1 border-t border-slate-100"></span>
          </div>

          <!-- Patch : pill dépliable — fichiers touchés + cartes diff (réutilise les diffs des tool parts du même message) -->
          <div v-else-if="item.kind === 'patch'" class="w-full">
            <button
              class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-500 font-mono max-w-full hover:bg-slate-100 transition-colors"
              @click="basculer(item.id)"
            >
              <i class="ph ph-git-diff text-slate-400 shrink-0"></i
              ><span class="truncate">{{ item.label }}</span>
              <i
                v-if="item.files && item.files.length"
                class="ph ph-caret-down text-slate-300 transition-transform shrink-0"
                :class="ouverts[item.id] ? 'rotate-180' : ''"
                style="font-size: 9px"
              ></i>
            </button>
            <div v-if="ouverts[item.id] && item.files && item.files.length" class="mt-2 space-y-2 w-full">
              <div v-if="!item.diff" class="rounded-lg border border-slate-200 bg-white/60 px-3 py-2">
                <div
                  v-for="f in item.files"
                  :key="f"
                  class="flex items-center gap-1.5 text-[11.5px] font-mono text-slate-600 py-0.5"
                >
                  <i class="ph ph-file-code text-slate-400 shrink-0"></i><span class="truncate">{{ f }}</span>
                </div>
              </div>
              <CarteDiff v-else :cid="'patch:' + item.id" :text="item.diff"></CarteDiff>
            </div>
          </div>

          <!-- Sous-agent lancé par la session (part `subtask`) : le TUI ouvre un encadré, la page affichait « subtask » en -->
          <div v-else-if="item.kind === 'subtask'" class="w-full">
            <div
              class="elpis-code-tool-row"
              :class="item.prompt ? 'elpis-code-tool-row-btn' : ''"
              @click="item.prompt && basculer(item.id)"
            >
              <img
                :src="cd.logoApp"
                alt=""
                data-logo-sous-agent
                class="w-4 h-4 rounded-full object-cover shrink-0"
              />
              <span class="font-mono text-[12px] font-semibold text-slate-600 shrink-0">{{
                item.agent
              }}</span>
              <span v-if="item.desc" class="text-[11.5px] text-slate-500 truncate">{{ item.desc }}</span>
              <span
                v-if="item.model"
                class="ml-auto pl-2 font-mono text-[11px] text-slate-400 shrink-0 truncate max-w-[10rem]"
                >{{ item.model }}</span
              >
              <button
                v-if="item.prompt"
                title="Consigne du sous-agent"
                :class="item.model ? '' : 'ml-auto'"
                class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                @click.stop="basculer(item.id)"
              >
                <i
                  class="ph ph-caret-down transition-transform"
                  :class="ouverts[item.id] ? 'rotate-180' : ''"
                  style="font-size: 9px"
                ></i>
              </button>
            </div>
            <pre
              v-if="ouverts[item.id] && item.prompt"
              class="mt-1.5 m-0 px-3 py-2 rounded-lg border border-slate-200 bg-white/60 text-[11px] text-slate-600 whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto custom-scrollbar"
              >{{ item.prompt }}</pre>
          </div>

          <!-- Compaction : c'est ce qui explique qu'un historique « disparaisse » côté CLI -->
          <div v-else-if="item.kind === 'compaction'" class="w-full flex justify-center py-0.5">
            <span
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-[11px] text-slate-500"
            >
              <i class="ph ph-arrows-in-line-horizontal text-slate-400" style="font-size: 11px"></i
              >{{ item.label }}
            </span>
          </div>

          <!-- Nouvelle tentative du modèle (quota, coupure réseau…) -->
          <div v-else-if="item.kind === 'retry'" class="w-full">
            <span
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-amber-500/15 text-amber-600"
              :title="item.detail"
            >
              <i class="ph ph-arrows-clockwise" style="font-size: 11px"></i>Tentative
              {{ item.attempt }}
            </span>
          </div>

          <div
            v-else-if="item.kind === 'file'"
            class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-500 font-mono max-w-full"
          >
            <i class="ph ph-paperclip text-slate-400 shrink-0"></i
            ><span class="truncate">{{ item.filename }}</span>
          </div>
          <div
            v-else-if="item.kind === 'unknown'"
            class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] bg-slate-50 border border-slate-100 text-slate-400 font-mono"
          >
            {{ item.type }}
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
