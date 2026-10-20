<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageRag.vue — page RAG de la console : services, droits et quotas, collections (métadonnées seulement), réindexation et travaux. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import RagLigneEssai from "./RagLigneEssai.vue";

const adm = domaineAdmin();

type Voyant = "ok" | "down" | "off" | "unknown";
interface Ligne {
  etat: Voyant;
  libelle: string;
}

const ETATS_COLLECTION = {
  ready: "Prête",
  indexing: "Indexation",
  migrating: "Migration",
  error: "En erreur",
};
const VISIBILITES = { private: "Privée", groups: "Groupes", all: "Tous les comptes" };
const GENRES = { ingest: "Dépôt", reindex: "Réindexation", migrate: "Migration de modèle", purge: "Purge" };
const ETATS_TRAVAIL = {
  queued: "En file",
  running: "En cours",
  paused: "Suspendu",
  done: "Terminé",
  failed: "Échec",
  cancelled: "Annulé",
};

function extracteur(): Ligne {
  const x = adm.ragAdmEtat?.extractor;
  if (!x) return { etat: "unknown", libelle: "État inconnu" };
  if (!x.configured) return { etat: "off", libelle: "Non configuré : aucun document ne peut être extrait" };
  if (x.ok === false) return { etat: "down", libelle: "Injoignable" + (x.error ? " (" + x.error + ")" : "") };
  const details = [
    x.version ? "version " + x.version : "",
    x.soffice === true ? "LibreOffice présent" : x.soffice === false ? "LibreOffice absent" : "",
  ];
  return { etat: "ok", libelle: ["Joignable", ...details].filter(Boolean).join(" · ") };
}

function qdrant(): Ligne {
  const q = adm.ragAdmEtat?.qdrant;
  if (!q) return { etat: "unknown", libelle: "État inconnu" };
  if (!q.configured) return { etat: "off", libelle: "Non configuré" };
  if (q.ok === false) return { etat: "down", libelle: "Injoignable" + (q.error ? " (" + q.error + ")" : "") };
  return { etat: "ok", libelle: "Prêt" + (q.version ? " · version " + q.version : "") };
}

function embeddings(): Ligne {
  const m = adm.ragAdmEtat?.embed;
  if (!m) return { etat: "unknown", libelle: "État inconnu" };
  if (!m.configured) return { etat: "off", libelle: "Non configuré : le RAG est désactivé" };
  return { etat: "unknown", libelle: "Enregistré · modèle " + m.model + " (à vérifier avec le test)" };
}

function reclassement(): Ligne {
  const r = adm.ragAdmEtat?.reranker;
  if (!r) return { etat: "unknown", libelle: "État inconnu" };
  return r.enabled
    ? { etat: "unknown", libelle: "Activé · modèle " + r.model + " (à vérifier avec le test)" }
    : { etat: "off", libelle: "Désactivé : les passages ne sont pas reclassés" };
}

function ocr(): Ligne {
  const o = adm.ragAdmEtat?.ocr;
  const x = adm.ragAdmEtat?.extractor;
  if (!o) return { etat: "unknown", libelle: "État inconnu" };
  if (!o.configured)
    return { etat: "off", libelle: "Non configuré : les documents scannés restent sans texte" };
  if (x && x.ok === true && x.ocr === false)
    return { etat: "down", libelle: "L'extracteur ne prend pas l'OCR en charge (version ancienne ?)" };
  return {
    etat: "unknown",
    libelle: "Enregistré" + (o.model ? " · modèle " + o.model : "") + " (à vérifier avec le test)",
  };
}

const pastille = (s: string): string => (s === "ready" ? "ok" : s === "error" ? "erreur" : "travail");
const mo = (v: number): string => Number(v).toLocaleString("fr-FR");
const depasse = (utilise: number, quotaMo: number): boolean => utilise > quotaMo * 1024 * 1024;
const pages = (total: number): number => Math.max(1, Math.ceil(total / adm.ragAdmPageTaille));
const pageCourante = (offset: number): number => Math.floor(offset / adm.ragAdmPageTaille) + 1;
</script>

<template>
  <div v-if="adm.adminTab === 'rag' && adm.adminIsAdmin" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <p v-if="adm.ragAdmErreur" class="adm-rag-avert" role="alert">
        <i class="ph ph-warning" aria-hidden="true"></i>{{ adm.ragAdmErreur }}
      </p>

      <!-- Services -->
      <section id="rag-extracteur" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-file-text adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Extracteur de documents</h3>
            <p class="adm-card__hint">
              Service Python sans état : lit les PDF, Word, Excel, PowerPoint et HTML, rend les pages et lit
              les scans.
            </p>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.rag" class="adm-rows">
          <div class="adm-row">
            <label class="adm-row__label" for="cnx-rag-url" title="Sans barre oblique finale.">Adresse</label>
            <input
              id="cnx-rag-url"
              v-model="adm.configForm.rag.service_url"
              data-field="config:rag.service_url"
              placeholder="http://127.0.0.1:8000"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="cnx-rag-token"
              title="Vide : le jeton de user_db/.rag_service_token, que l'extracteur local lit aussi. À remplir pour un extracteur sur une autre machine."
              >Jeton</label
            >
            <input
              id="cnx-rag-token"
              v-model="adm.configForm.rag.service_token"
              data-field="config:rag.service_token"
              type="password"
              autocomplete="new-password"
              placeholder="facultatif"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="cnx-rag-timeout"
              title="Au-delà, l'outil renvoie une erreur récupérable."
              >Délai maximal</label
            >
            <div class="flex items-center gap-2">
              <input
                id="cnx-rag-timeout"
                v-model.number="adm.configForm.rag.service_timeout"
                data-field="config:rag.service_timeout"
                type="number"
                min="1"
                max="300"
                class="set-input adm-num"
              />
              <span class="adm-unit">s</span>
            </div>
          </div>
          <RagLigneEssai service="extracteur" :etat="extracteur().etat" :libelle="extracteur().libelle" />
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section id="rag-qdrant" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-database adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Base vectorielle (Qdrant)</h3>
            <p class="adm-card__hint">
              Une collection Qdrant par collection du RAG ; reconstruite par la réindexation.
            </p>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.rag" class="adm-rows">
          <div class="adm-row">
            <label class="adm-row__label" for="rag-qdrant-url" title="Sans barre oblique finale."
              >Adresse</label
            >
            <input
              id="rag-qdrant-url"
              v-model="adm.configForm.rag.qdrant_url"
              data-field="config:rag.qdrant_url"
              placeholder="http://127.0.0.1:6333"
              class="set-input font-mono text-xs"
            />
          </div>
          <RagLigneEssai service="qdrant" :etat="qdrant().etat" :libelle="qdrant().libelle" />
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section id="rag-embeddings" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-brain adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Embeddings</h3>
            <p class="adm-card__hint">
              Serveur compatible OpenAI (<code class="font-mono">/v1/embeddings</code>). Sans adresse, le RAG
              est désactivé : dépôts refusés et indexation au repos.
            </p>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.rag" class="adm-rows">
          <div class="adm-row">
            <label class="adm-row__label" for="rag-embed-url" title="Sans barre oblique finale ni /v1."
              >Adresse</label
            >
            <input
              id="rag-embed-url"
              v-model="adm.configForm.rag.embed.url"
              data-field="config:rag.embed.url"
              placeholder="http://127.0.0.1:8081"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="rag-embed-model"
              title="Changer de modèle demande de réindexer les collections (carte Réindexation plus bas)."
              >Modèle</label
            >
            <div class="min-w-0">
              <input
                id="rag-embed-model"
                v-model="adm.configForm.rag.embed.model"
                data-field="config:rag.embed.model"
                placeholder="bge-m3"
                class="set-input font-mono text-xs"
              />
              <p v-if="adm.ragAdmModeleModifie" class="adm-rag-note mt-1" role="status">
                Après l'enregistrement, chaque collection est reconstruite avec ce modèle à sa prochaine
                indexation ; « Réindexer toutes les collections » (plus bas) le fait tout de suite.
              </p>
            </div>
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-embed-key" title="Vide si le serveur est en accès ouvert."
              >Clé d'API</label
            >
            <input
              id="rag-embed-key"
              v-model="adm.configForm.rag.embed.api_key"
              data-field="config:rag.embed.api_key"
              type="password"
              autocomplete="new-password"
              placeholder="facultatif"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-embed-batch" title="Passages envoyés par requête."
              >Lot</label
            >
            <div class="flex items-center gap-2">
              <input
                id="rag-embed-batch"
                v-model.number="adm.configForm.rag.embed.batch"
                data-field="config:rag.embed.batch"
                type="number"
                min="1"
                max="512"
                class="set-input adm-num"
              />
              <span class="adm-unit">passages</span>
            </div>
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-embed-timeout" title="Par requête d'embeddings."
              >Délai</label
            >
            <div class="flex items-center gap-2">
              <input
                id="rag-embed-timeout"
                v-model.number="adm.configForm.rag.embed.timeout_s"
                data-field="config:rag.embed.timeout_s"
                type="number"
                min="1"
                max="600"
                class="set-input adm-num"
              />
              <span class="adm-unit">s</span>
            </div>
          </div>
          <RagLigneEssai service="embeddings" :etat="embeddings().etat" :libelle="embeddings().libelle" />
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section id="rag-options" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-sort-ascending adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Reclassement et OCR</h3>
            <p class="adm-card__hint">
              Deux options : le RAG fonctionne sans elles. Lues à chaud, sans redémarrage.
            </p>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.rag" class="adm-rows">
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="rag-rerank-on"
              title="Reclasse les passages trouvés avec un modèle dédié (/v1/rerank)."
              >Reclassement</label
            >
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="rag-rerank-on"
                v-model="adm.configForm.rag.reranker.enabled"
                type="checkbox"
                data-field="config:rag.reranker.enabled"
                class="sr-only peer"
              />
              <span class="set-switch-track adm-rag-sw block"></span>
              <span class="adm-rag-valeur">{{
                adm.configForm.rag.reranker.enabled ? "Activé" : "Désactivé"
              }}</span>
            </label>
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-rerank-url" title="Sans barre oblique finale ni /v1."
              >Adresse</label
            >
            <input
              id="rag-rerank-url"
              v-model="adm.configForm.rag.reranker.url"
              data-field="config:rag.reranker.url"
              placeholder="http://127.0.0.1:8082"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-rerank-model">Modèle</label>
            <input
              id="rag-rerank-model"
              v-model="adm.configForm.rag.reranker.model"
              data-field="config:rag.reranker.model"
              placeholder="bge-reranker-v2-m3"
              class="set-input font-mono text-xs"
            />
          </div>
          <RagLigneEssai service="reranker" :etat="reclassement().etat" :libelle="reclassement().libelle" />
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="rag-ocr-url"
              title="Modèle de vision compatible OpenAI (/v1/chat/completions) qui lit les pages scannées. Vide : pas d'OCR."
              >OCR : adresse</label
            >
            <input
              id="rag-ocr-url"
              v-model="adm.configForm.rag.ocr.url"
              data-field="config:rag.ocr.url"
              placeholder="aucun"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="rag-ocr-model"
              title="Vide : le premier modèle annoncé par le serveur."
              >OCR : modèle</label
            >
            <input
              id="rag-ocr-model"
              v-model="adm.configForm.rag.ocr.model"
              data-field="config:rag.ocr.model"
              placeholder="automatique"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="rag-ocr-key" title="Vide si le serveur est en accès ouvert."
              >OCR : clé d'API</label
            >
            <input
              id="rag-ocr-key"
              v-model="adm.configForm.rag.ocr.api_key"
              data-field="config:rag.ocr.api_key"
              type="password"
              autocomplete="new-password"
              placeholder="facultatif"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="rag-ocr-timeout"
              title="Délai de lecture d'une page par le modèle."
              >OCR : délai</label
            >
            <div class="flex items-center gap-2">
              <input
                id="rag-ocr-timeout"
                v-model.number="adm.configForm.rag.ocr.timeout_s"
                data-field="config:rag.ocr.timeout_s"
                type="number"
                min="5"
                max="3600"
                class="set-input adm-num"
              />
              <span class="adm-unit">s par page</span>
            </div>
          </div>
          <RagLigneEssai service="ocr" :etat="ocr().etat" :libelle="ocr().libelle" />
          <p class="adm-rag-note px-5 pb-3">
            Chaque propriétaire active ensuite l'OCR pour ses collections (onglet Réglages de la page RAG).
          </p>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <!-- Droits -->
      <section id="rag-droits" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-lock-key adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Droits et limites</h3>
            <p class="adm-card__hint">
              L'administrateur voit les métadonnées des collections, jamais leur contenu privé.
            </p>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.rag" class="adm-rows">
          <div class="adm-row adm-row--top">
            <span
              class="adm-row__label"
              title="Aucun groupe coché : tous les comptes. Les administrateurs ont toujours accès."
              >Accès au RAG</span
            >
            <div
              class="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Groupes autorisés"
              data-field="config:rag.groups"
            >
              <button
                type="button"
                class="elpis-img-chip"
                :aria-pressed="!(adm.configForm.rag.groups || []).length ? 'true' : 'false'"
                @click="adm.ragAdmFixerGroupes([])"
              >
                Tous
              </button>
              <button
                v-for="g in adm.groupsList"
                :key="g.id"
                type="button"
                class="elpis-img-chip"
                :aria-pressed="(adm.configForm.rag.groups || []).includes(g.id) ? 'true' : 'false'"
                @click="adm.ragAdmBasculerGroupe(g.id)"
              >
                {{ g.name }}
              </button>
              <span
                v-for="gid in adm.ragAdmGroupesAbsents"
                :key="'x' + gid"
                class="elpis-img-chip is-gone"
                title="Groupe supprimé : ne donne accès à personne."
                >#{{ gid }}
                <button
                  type="button"
                  class="elpis-img-chip__x"
                  aria-label="Retirer"
                  @click="adm.ragAdmBasculerGroupe(gid)"
                >
                  <i class="ph ph-x" aria-hidden="true"></i>
                </button>
              </span>
            </div>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label">Publication</span>
            <ul class="adm-rag-regles">
              <li>
                Publier à « Tous les comptes » est réservé aux <strong>administrateurs</strong> ; les
                modérateurs ne comptent pas comme administrateurs pour le RAG.
              </li>
              <li>Un utilisateur ne publie qu'aux groupes dont il est membre.</li>
              <li>
                La règle est continue : si l'auteur perd ce droit (groupe quitté, rôle retiré), la publication
                cesse d'être effective sans rien effacer.
              </li>
            </ul>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label" title="Valeurs des comptes sans surcharge (carte suivante)."
              >Quotas par défaut</span
            >
            <div class="adm-rag-grid">
              <div class="adm-rag-champ">
                <label for="rag-quota-storage_mb">Stockage</label>
                <div class="flex items-center gap-2">
                  <input
                    id="rag-quota-storage_mb"
                    v-model.number="adm.configForm.rag.quotas.storage_mb"
                    data-field="config:rag.quotas.storage_mb"
                    aria-label="Stockage"
                    type="number"
                    min="0"
                    class="set-input adm-num"
                  />
                  <span class="adm-unit">Mo</span>
                </div>
              </div>
              <div class="adm-rag-champ">
                <label for="rag-quota-collections">Collections</label>
                <input
                  id="rag-quota-collections"
                  v-model.number="adm.configForm.rag.quotas.collections"
                  data-field="config:rag.quotas.collections"
                  aria-label="Collections"
                  type="number"
                  min="0"
                  class="set-input adm-num"
                />
              </div>
              <div class="adm-rag-champ">
                <label for="rag-quota-file_mb">Taille d'un fichier</label>
                <div class="flex items-center gap-2">
                  <input
                    id="rag-quota-file_mb"
                    v-model.number="adm.configForm.rag.quotas.file_mb"
                    data-field="config:rag.quotas.file_mb"
                    aria-label="Taille d'un fichier"
                    type="number"
                    min="0"
                    class="set-input adm-num"
                  />
                  <span class="adm-unit">Mo</span>
                </div>
              </div>
              <div class="adm-rag-champ">
                <label for="rag-quota-docs_per_collection">Documents par collection</label>
                <input
                  id="rag-quota-docs_per_collection"
                  v-model.number="adm.configForm.rag.quotas.docs_per_collection"
                  data-field="config:rag.quotas.docs_per_collection"
                  aria-label="Documents par collection"
                  type="number"
                  min="0"
                  class="set-input adm-num"
                />
              </div>
            </div>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label" title="Documents indexés en même temps."
              >Concurrence d'indexation</span
            >
            <div class="adm-rag-grid">
              <div class="adm-rag-champ">
                <label for="rag-conc">Sur l'instance</label>
                <input
                  id="rag-conc"
                  v-model.number="adm.configForm.rag.indexation.concurrence"
                  data-field="config:rag.indexation.concurrence"
                  aria-label="Concurrence sur l'instance"
                  type="number"
                  min="1"
                  max="16"
                  class="set-input adm-num"
                />
              </div>
              <div class="adm-rag-champ">
                <label for="rag-conc-compte">Par compte</label>
                <input
                  id="rag-conc-compte"
                  v-model.number="adm.configForm.rag.indexation.par_compte"
                  data-field="config:rag.indexation.par_compte"
                  aria-label="Concurrence par compte"
                  type="number"
                  min="1"
                  max="16"
                  class="set-input adm-num"
                />
              </div>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section id="rag-quotas" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-users adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              Quotas par compte <span class="font-normal adm-muted">· {{ adm.ragAdmComptesTotal }}</span>
            </h3>
            <p class="adm-card__hint">
              Une surcharge remplace la valeur par défaut, clé par clé. Une valeur plus basse que l'usage
              actuel n'efface rien : elle bloque seulement les nouveaux dépôts.
            </p>
          </div>
        </header>
        <div class="adm-rag-outils">
          <label class="sr-only" for="rag-comptes-q">Rechercher un compte</label>
          <input
            id="rag-comptes-q"
            v-model="adm.ragAdmComptesFiltre.q"
            type="search"
            class="set-input"
            placeholder="Rechercher un compte"
            autocomplete="off"
          />
          <label class="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input v-model="adm.ragAdmComptesFiltre.surcharges" type="checkbox" />
            Seulement les comptes avec surcharge
          </label>
        </div>
        <p v-if="!adm.ragAdmComptes.length" class="adm-empty px-5">Aucun compte ne correspond.</p>
        <div v-else class="overflow-x-auto">
          <table class="adm-table">
            <caption class="sr-only">
              Consommation et quotas RAG par compte
            </caption>
            <thead>
              <tr>
                <th scope="col">Compte</th>
                <th scope="col" class="adm-rag-num">Stockage</th>
                <th scope="col" class="adm-rag-num">Collections</th>
                <th scope="col" class="adm-rag-num">Documents</th>
                <th scope="col">Quotas effectifs</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="c in adm.ragAdmComptes" :key="c.id">
                <tr>
                  <td>
                    <span class="font-medium">{{ c.username }}</span>
                    <span v-if="c.role !== 'user'" class="adm-pill ml-1">{{
                      c.role === "admin" ? "Admin" : "Modérateur"
                    }}</span>
                    <span
                      v-if="!c.rag_allowed"
                      class="adm-pill adm-pill--warn ml-1"
                      title="Hors des groupes autorisés"
                      >Sans droit RAG</span
                    >
                    <span v-if="c.override" class="adm-rag-pastille ml-1" data-state="travail"
                      >Surcharge</span
                    >
                  </td>
                  <td
                    class="adm-rag-num"
                    :class="{ 'adm-rag-depasse': depasse(c.usage.storage_bytes, c.effective.storage_mb) }"
                  >
                    {{ adm.ragAdmOctets(c.usage.storage_bytes) }}
                    <span class="adm-muted">/ {{ mo(c.effective.storage_mb) }} Mo</span>
                  </td>
                  <td
                    class="adm-rag-num"
                    :class="{ 'adm-rag-depasse': c.usage.collections > c.effective.collections }"
                  >
                    {{ c.usage.collections }}
                    <span class="adm-muted">/ {{ mo(c.effective.collections) }}</span>
                  </td>
                  <td class="adm-rag-num">{{ mo(c.usage.documents) }}</td>
                  <td class="adm-muted">
                    fichier {{ mo(c.effective.file_mb) }} Mo ·
                    {{ mo(c.effective.docs_per_collection) }} doc/collection
                  </td>
                  <td class="text-right">
                    <button
                      type="button"
                      class="adm-btn adm-btn--quiet adm-btn--sm"
                      :aria-expanded="
                        adm.ragAdmQuotaEdition && adm.ragAdmQuotaEdition.id === c.id ? 'true' : 'false'
                      "
                      :aria-label="'Modifier les quotas de ' + c.username"
                      @click="
                        adm.ragAdmQuotaEdition && adm.ragAdmQuotaEdition.id === c.id
                          ? adm.ragAdmFermerQuota()
                          : adm.ragAdmOuvrirQuota(c)
                      "
                    >
                      <i class="ph ph-pencil-simple" aria-hidden="true"></i> Modifier
                    </button>
                    <button
                      v-if="c.override"
                      type="button"
                      class="adm-btn adm-btn--quiet adm-btn--sm"
                      :aria-label="'Rétablir les quotas de ' + c.username + ' aux valeurs de l\'instance'"
                      @click="adm.ragAdmRetablirQuota(c)"
                    >
                      <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Rétablir
                    </button>
                  </td>
                </tr>
                <tr
                  v-if="adm.ragAdmQuotaEdition && adm.ragAdmQuotaEdition.id === c.id"
                  class="adm-rag-panneau-ligne"
                >
                  <td colspan="6" class="adm-rag-panneau" @keydown.esc="adm.ragAdmFermerQuota()">
                    <div role="group" :aria-label="'Quotas de ' + c.username">
                      <div class="adm-rag-grid">
                        <div v-for="k in adm.ragAdmClesQuotas" :key="k" class="adm-rag-champ">
                          <label :for="'rag-q-' + c.id + '-' + k">{{
                            adm.ragAdmLibellesQuotas[k].label
                          }}</label>
                          <div class="flex items-center gap-2">
                            <input
                              :id="'rag-q-' + c.id + '-' + k"
                              v-model="adm.ragAdmQuotaEdition.valeurs[k]"
                              type="text"
                              inputmode="numeric"
                              class="set-input adm-num"
                              :placeholder="String(adm.ragAdmEtat ? adm.ragAdmEtat.quotas[k] : '')"
                              autocomplete="off"
                              @keydown.enter.prevent="adm.ragAdmEnregistrerQuota()"
                            />
                            <span v-if="adm.ragAdmLibellesQuotas[k].unite" class="adm-unit">{{
                              adm.ragAdmLibellesQuotas[k].unite
                            }}</span>
                          </div>
                        </div>
                      </div>
                      <p class="adm-rag-note mt-2">
                        Un champ vide garde la valeur de l'instance (affichée en grisé). 0 interdit tout
                        nouveau dépôt.
                      </p>
                      <p
                        v-if="adm.ragAdmQuotaEdition.erreur"
                        class="adm-rag-resultat"
                        data-state="down"
                        role="alert"
                      >
                        {{ adm.ragAdmQuotaEdition.erreur }}
                      </p>
                      <div class="adm-rag-ligne mt-2">
                        <button
                          type="button"
                          class="adm-btn adm-tool adm-btn--sm"
                          :disabled="adm.ragAdmQuotaEdition.busy"
                          @click="adm.ragAdmEnregistrerQuota()"
                        >
                          <i class="ph ph-floppy-disk" aria-hidden="true"></i> Enregistrer
                        </button>
                        <button
                          type="button"
                          class="adm-btn adm-btn--quiet adm-btn--sm"
                          @click="adm.ragAdmFermerQuota()"
                        >
                          Annuler
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div v-if="adm.ragAdmComptesTotal > adm.ragAdmPageTaille" class="adm-rag-pied">
          <span
            >Page {{ pageCourante(adm.ragAdmComptesFiltre.offset) }} sur
            {{ pages(adm.ragAdmComptesTotal) }}</span
          >
          <span class="flex gap-2">
            <button
              type="button"
              class="adm-btn adm-tool adm-btn--sm"
              :disabled="adm.ragAdmComptesFiltre.offset <= 0"
              @click="adm.ragAdmPageComptes(-1)"
            >
              Précédente
            </button>
            <button
              type="button"
              class="adm-btn adm-tool adm-btn--sm"
              :disabled="adm.ragAdmComptesFiltre.offset + adm.ragAdmPageTaille >= adm.ragAdmComptesTotal"
              @click="adm.ragAdmPageComptes(1)"
            >
              Suivante
            </button>
          </span>
        </div>
      </section>

      <!-- Collections -->
      <section id="rag-collections" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-books adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              Collections <span class="font-normal adm-muted">· {{ adm.ragAdmCollectionsTotal }}</span>
            </h3>
            <p class="adm-card__hint">
              Métadonnées seulement : ni documents, ni passages, ni descriptions. Supprimer efface la
              collection pour tout le monde, son auteur et ses lecteurs sont prévenus.
            </p>
          </div>
        </header>
        <div class="adm-rag-outils">
          <label class="sr-only" for="rag-coll-q">Rechercher une collection ou un auteur</label>
          <input
            id="rag-coll-q"
            v-model="adm.ragAdmFiltres.q"
            type="search"
            class="set-input"
            placeholder="Collection ou auteur"
            autocomplete="off"
          />
          <label class="sr-only" for="rag-coll-vis">Visibilité</label>
          <select id="rag-coll-vis" v-model="adm.ragAdmFiltres.visibility" class="set-select">
            <option value="">Toute visibilité</option>
            <option value="private">Privée</option>
            <option value="groups">Groupes</option>
            <option value="all">Tous les comptes</option>
          </select>
          <label class="sr-only" for="rag-coll-etat">État</label>
          <select id="rag-coll-etat" v-model="adm.ragAdmFiltres.status" class="set-select">
            <option value="">Tout état</option>
            <option value="ready">Prête</option>
            <option value="indexing">Indexation</option>
            <option value="migrating">Migration</option>
            <option value="error">En erreur</option>
          </select>
          <label class="sr-only" for="rag-coll-tri">Trier par</label>
          <select id="rag-coll-tri" v-model="adm.ragAdmFiltres.tri" class="set-select">
            <option value="nom">Tri : nom</option>
            <option value="auteur">Tri : auteur</option>
            <option value="taille">Tri : taille</option>
            <option value="documents">Tri : documents</option>
            <option value="recent">Tri : récentes</option>
          </select>
        </div>
        <p v-if="!adm.ragAdmCollections.length && !adm.ragAdmCollectionsCharge" class="adm-empty px-5">
          {{
            adm.ragAdmFiltres.q || adm.ragAdmFiltres.visibility || adm.ragAdmFiltres.status
              ? "Aucune collection ne correspond aux filtres."
              : "Aucune collection pour l'instant."
          }}
        </p>
        <div v-else class="overflow-x-auto">
          <table class="adm-table">
            <caption class="sr-only">
              Collections RAG de l'instance
            </caption>
            <thead>
              <tr>
                <th scope="col">Collection</th>
                <th scope="col">Auteur</th>
                <th scope="col">Visibilité</th>
                <th scope="col" class="adm-rag-num">Taille</th>
                <th scope="col" class="adm-rag-num">Documents</th>
                <th scope="col">État</th>
                <th scope="col">Dernière indexation</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in adm.ragAdmCollections" :key="c.id">
                <td>
                  <span class="font-medium">{{ c.name }}</span>
                  <span class="adm-muted block text-xs">{{ c.embed_model || "pas encore indexée" }}</span>
                </td>
                <td>{{ c.owner.username }}</td>
                <td>
                  <span class="adm-pill" :title="c.groups.map((g) => g.name).join(', ')">
                    {{ VISIBILITES[c.visibility]
                    }}<template v-if="c.visibility === 'groups'"> · {{ c.groups.length }}</template>
                  </span>
                </td>
                <td class="adm-rag-num">{{ adm.ragAdmOctets(c.bytes) }}</td>
                <td class="adm-rag-num">{{ mo(c.doc_count) }}</td>
                <td>
                  <span class="adm-rag-pastille" :data-state="pastille(c.status)">{{
                    ETATS_COLLECTION[c.status]
                  }}</span>
                  <span v-if="c.job" class="adm-muted block text-xs">
                    {{ GENRES[c.job.kind] }} {{ adm.ragAdmPourcent(c.job) }} % ({{ c.job.done }}/{{
                      c.job.total
                    }})
                  </span>
                </td>
                <td class="adm-muted">{{ adm.ragAdmDate(c.last_indexed_at) || "—" }}</td>
                <td class="text-right">
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm adm-btn--danger-quiet"
                    :aria-label="'Supprimer la collection ' + c.name"
                    @click="adm.ragAdmSupprimerCollection(c)"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="adm.ragAdmCollectionsTotal > adm.ragAdmPageTaille" class="adm-rag-pied">
          <span
            >Page {{ pageCourante(adm.ragAdmFiltres.offset) }} sur
            {{ pages(adm.ragAdmCollectionsTotal) }}</span
          >
          <span class="flex gap-2">
            <button
              type="button"
              class="adm-btn adm-tool adm-btn--sm"
              :disabled="adm.ragAdmFiltres.offset <= 0"
              @click="adm.ragAdmPageCollections(-1)"
            >
              Précédente
            </button>
            <button
              type="button"
              class="adm-btn adm-tool adm-btn--sm"
              :disabled="adm.ragAdmFiltres.offset + adm.ragAdmPageTaille >= adm.ragAdmCollectionsTotal"
              @click="adm.ragAdmPageCollections(1)"
            >
              Suivante
            </button>
          </span>
        </div>
      </section>

      <!-- Réindexation -->
      <section id="rag-reindexation" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-arrows-clockwise adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Changement de modèle d'embedding</h3>
            <p class="adm-card__hint">
              Chaque collection est reconstruite à côté de l'ancienne, qui continue de servir jusqu'à la
              bascule.
            </p>
          </div>
        </header>
        <div v-if="adm.ragAdmReindexation" class="adm-rows">
          <div class="adm-row">
            <span class="adm-row__label">Modèle configuré</span>
            <span class="font-mono text-xs">{{ adm.ragAdmReindexation.model }}</span>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label">Collections</span>
            <div class="min-w-0">
              <p class="text-sm">
                <strong>{{ adm.ragAdmReindexation.up_to_date }}</strong> à jour ·
                <strong :class="{ 'adm-rag-depasse': adm.ragAdmReindexation.to_migrate > 0 }">{{
                  adm.ragAdmReindexation.to_migrate
                }}</strong>
                à migrer · {{ adm.ragAdmReindexation.empty }} pas encore indexée{{
                  adm.ragAdmReindexation.empty > 1 ? "s" : ""
                }}
              </p>
              <p v-if="adm.ragAdmReindexation.by_model.length" class="adm-rag-note mt-1">
                Par modèle :
                <span v-for="m in adm.ragAdmReindexation.by_model" :key="m.model" class="adm-pill mr-1"
                  ><span class="font-mono">{{ m.model }}</span> · {{ m.collections }}</span
                >
              </p>
            </div>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label">Réindexer</span>
            <div class="min-w-0">
              <div class="adm-rag-ligne">
                <button
                  type="button"
                  class="adm-btn adm-btn--primary"
                  :disabled="
                    adm.ragAdmReindexEnCours ||
                    !adm.ragAdmReindexation.embed_configured ||
                    (!adm.ragAdmForcer && adm.ragAdmReindexation.to_migrate === 0)
                  "
                  @click="adm.ragAdmReindexerTout()"
                >
                  <i
                    class="ph"
                    :class="adm.ragAdmReindexEnCours ? 'ph-circle-notch animate-spin' : 'ph-arrows-clockwise'"
                    aria-hidden="true"
                  ></i>
                  Réindexer toutes les collections
                </button>
                <label class="inline-flex items-center gap-2 text-sm cursor-pointer">
                  <input v-model="adm.ragAdmForcer" type="checkbox" />
                  Même celles qui utilisent déjà ce modèle
                </label>
              </div>
              <p v-if="!adm.ragAdmReindexation.embed_configured" class="adm-rag-note mt-1">
                Aucun serveur d'embeddings n'est configuré : le RAG est désactivé.
              </p>
              <p
                v-else-if="adm.ragAdmReindexation.to_migrate === 0 && !adm.ragAdmForcer"
                class="adm-rag-note mt-1"
              >
                Toutes les collections indexées utilisent déjà le modèle configuré.
              </p>
            </div>
          </div>
          <div v-if="adm.ragAdmReindexation.jobs.length" class="adm-row adm-row--top">
            <span class="adm-row__label">Progression</span>
            <div class="min-w-0" aria-live="polite">
              <div
                class="adm-rag-barre"
                role="progressbar"
                aria-label="Progression de la réindexation"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="adm.ragAdmProgressionGlobale"
              >
                <span :style="{ width: adm.ragAdmProgressionGlobale + '%' }"></span>
              </div>
              <p class="adm-rag-note mt-1">
                {{ adm.ragAdmReindexation.progress.collections }} collection{{
                  adm.ragAdmReindexation.progress.collections > 1 ? "s" : ""
                }}
                en cours · {{ adm.ragAdmReindexation.progress.done }} /
                {{ adm.ragAdmReindexation.progress.total }} documents ({{ adm.ragAdmProgressionGlobale }}
                %)
                <span v-if="adm.ragAdmReindexation.progress.failed">
                  · {{ adm.ragAdmReindexation.progress.failed }} en échec</span
                >
              </p>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section id="rag-travaux" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-list-checks adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              Travaux d'indexation
              <span class="font-normal adm-muted">· {{ adm.ragAdmTravaux.length }}</span>
            </h3>
            <p class="adm-card__hint">
              Travaux à mener, de tous les comptes. L'indexation tourne dans le processus principal ; la
              console écrit dans la base et le travailleur reprend en quelques secondes.
              <template v-if="adm.ragAdmEtat">
                Actuellement : {{ adm.ragAdmEtat.indexation.jobs.running }} en cours,
                {{ adm.ragAdmEtat.indexation.jobs.queued }} en file,
                {{ adm.ragAdmEtat.indexation.jobs.paused }} suspendu{{
                  adm.ragAdmEtat.indexation.jobs.paused > 1 ? "s" : ""
                }}.
              </template>
            </p>
          </div>
        </header>
        <p v-if="!adm.ragAdmTravaux.length" class="adm-empty px-5">Aucun travail en cours.</p>
        <div v-else class="overflow-x-auto">
          <table class="adm-table">
            <caption class="sr-only">
              Travaux d'indexation en cours
            </caption>
            <thead>
              <tr>
                <th scope="col">Collection</th>
                <th scope="col">Auteur</th>
                <th scope="col">Travail</th>
                <th scope="col">État</th>
                <th scope="col">Avancement</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="j in adm.ragAdmTravaux" :key="j.id">
                <td class="font-medium">{{ j.collection_name }}</td>
                <td>{{ j.owner.username }}</td>
                <td>{{ GENRES[j.kind] }}</td>
                <td>
                  <span class="adm-rag-pastille" :data-state="j.status === 'paused' ? 'erreur' : 'travail'">{{
                    ETATS_TRAVAIL[j.status]
                  }}</span>
                  <span v-if="j.error" class="adm-muted block text-xs" :title="j.error"
                    >en attente d'un service</span
                  >
                </td>
                <td style="min-width: 10rem">
                  <div
                    class="adm-rag-barre"
                    role="progressbar"
                    :aria-label="'Avancement de ' + j.collection_name"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="adm.ragAdmPourcent(j)"
                  >
                    <span :style="{ width: adm.ragAdmPourcent(j) + '%' }"></span>
                  </div>
                  <span class="adm-muted text-xs"
                    >{{ j.done }} / {{ j.total
                    }}<template v-if="j.failed"> · {{ j.failed }} en échec</template></span
                  >
                </td>
                <td class="text-right">
                  <button
                    v-if="j.status === 'paused'"
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    :aria-label="'Reprendre le travail de ' + j.collection_name"
                    @click="adm.ragAdmActionTravail(j, 'reprendre')"
                  >
                    <i class="ph ph-play" aria-hidden="true"></i> Reprendre
                  </button>
                  <button
                    v-else
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    :aria-label="'Suspendre le travail de ' + j.collection_name"
                    @click="adm.ragAdmActionTravail(j, 'suspendre')"
                  >
                    <i class="ph ph-pause" aria-hidden="true"></i> Suspendre
                  </button>
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm adm-btn--danger-quiet"
                    :aria-label="'Annuler le travail de ' + j.collection_name"
                    @click="adm.ragAdmActionTravail(j, 'annuler')"
                  >
                    <i class="ph ph-x" aria-hidden="true"></i> Annuler
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
