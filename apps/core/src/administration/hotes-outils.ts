// SPDX-License-Identifier: MIT
/** apps/core/src/administration/hotes-outils.ts — hôtes d'outils vus par la console : santé sondée (jeton jamais rendu), affectations, migration du `/work` d'un compte entre hôtes (shared_infra/routes/admin/toolhosts.py, sandbox/placement.py). */
import { randomBytes } from "node:crypto";

import {
  FlottantPy,
  floatPy,
  getPy,
  intPy,
  ouPy,
  prefixePy,
  pyJsonLoads,
  rstripPy,
  strPy,
  texteJsonPy,
  texteOu,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { ClientHttp, delais, getReasonPhrase, raiseForStatus } from "../llm/client-http";
import { estDict, lire } from "../relais/dict";
import type { Spec } from "../relais/dict";
import { hostFromSpec, lireHotes } from "../relais/hotes";
import type { HotesDeclares, SandboxHost } from "../relais/hotes";
import { entetesRelais } from "../relais/identite";
import { assign, placementOf } from "../relais/placement";

const CHAMPS_SANTE = ["families", "tools", "uptime_s", "auth", "service"] as const;
const DELAI_MIGRATION_S = 600;

/** `_hosts()` : hôtes déclarés (`sandboxHosts`/`toolHosts`) et stratégie de placement du manifeste. */
export function hotesDeclares(): HotesDeclares {
  return lireHotes();
}

/** `_probe` : `GET <url>/health` (2,5 s) ; `has_token` seulement, jamais le jeton ; une panne donne `reachable: false` et son message. */
export async function sonderHote(id: string, spec: Spec): Promise<Dict> {
  const url = rstripPy(texteOu(lire(spec, "url"), ""), "/");
  const out: Dict = {
    id,
    url,
    has_token: veritePy(lire(spec, "token")),
    relay: lire(spec, "relay") ?? null,
    reachable: null,
    health: null,
  };
  if (!url) return out;
  const client = new ClientHttp({ delais: delais(2.5) });
  try {
    const r = await client.get(`${url}/health`);
    out["reachable"] = r.statusCode === 200;
    if (r.statusCode === 200) {
      const h = pyJsonLoads(texteJsonPy(r.content));
      const sante: Dict = {};
      for (const k of CHAMPS_SANTE) sante[k] = getPy(h, k);
      out["health"] = sante;
    }
  } catch (e) {
    out["reachable"] = false;
    out["error"] = prefixePy(e instanceof Error ? e.message : String(e), 160);
  } finally {
    await client.aclose();
  }
  return out;
}

/** Transports que l'hôte sert pour chaque famille vivante (`endpoints` de son `/manifest`, 2,5 s) ; `null` si l'hôte ne répond pas. */
export async function transportsParFamille(
  hote: SandboxHost,
  uid: number,
): Promise<Map<string, Set<string>> | null> {
  const client = new ClientHttp({ delais: delais(2.5) });
  try {
    const r = await client.get(`${hote.url}/manifest`, { headers: await entetesRelais(hote, uid) });
    if (r.statusCode !== 200) return null;
    const eps = getPy(pyJsonLoads(texteJsonPy(r.content)), "endpoints");
    if (!estDict(eps)) return null;
    const out = new Map<string, Set<string>>();
    for (const [famille, v] of Object.entries(eps)) if (estDict(v)) out.set(famille, new Set(Object.keys(v)));
    return out;
  } catch {
    return null;
  } finally {
    await client.aclose();
  }
}

/** `list_placements` : affectations triées par compte, dates en float Python ; base illisible : `[]`. */
export async function listPlacements(base: Executeur): Promise<Dict[]> {
  try {
    const lignes = await base.valeurs(
      "SELECT user_id, host_id, created_at, updated_at FROM sandbox_placements ORDER BY user_id",
    );
    return lignes.map((r) => ({
      user_id: intPy(r[0]),
      host_id: strPy(r[1]),
      created_at: new FlottantPy(floatPy(r[2])),
      updated_at: new FlottantPy(floatPy(r[3])),
    }));
  } catch {
    return [];
  }
}

/** `unassign` : le compte reprendra l'hôte le moins chargé à sa prochaine utilisation. */
export async function unassign(base: Executeur, uid: number): Promise<void> {
  await base.run("DELETE FROM sandbox_placements WHERE user_id=?", [uid]);
}

/** `_host_spec` : hôte d'outils déclaré sous cet id, `null` sans URL. */
function hoteDe(hostId: string): SandboxHost | null {
  const spec = lireHotes().hotes.get(hostId);
  return hostFromSpec(hostId, estDict(spec) ? spec : {});
}

/** Hôte qui sert un compte sans affectation (`_local_export` du Python, sans bac à sable local en TS) : celui du placement, sinon le premier déclaré. */
function hoteParDefaut(): string {
  const { hotes, placement } = lireHotes();
  const id = texteOu(lire(placement, "host"), "");
  return id && hotes.has(id) ? id : (hotes.keys().next().value ?? "");
}

/** `export_work` : archive tar.gz du `/work` du compte sur cet hôte (relais, 600 s) ; erreur HTTP au format de httpx. */
async function exporterTravail(uid: number, hostId: string): Promise<Buffer> {
  const hote = hoteDe(hostId);
  if (hote === null) throw new Error(`hôte inconnu : ${hostId}`);
  const client = new ClientHttp({ delais: delais(DELAI_MIGRATION_S) });
  try {
    const r = await client.get(`${hote.url}/api/sandbox/export`, { headers: await entetesRelais(hote, uid) });
    raiseForStatus(r);
    return Buffer.from(r.content);
  } finally {
    await client.aclose();
  }
}

/** `import_work` : dépôt multipart de l'archive (`archive`, work.tar.gz) écrit comme httpx, délai de 600 s ; rend `files` de la réponse. */
async function importerTravail(uid: number, hostId: string, archive: Buffer): Promise<number> {
  const hote = hoteDe(hostId);
  if (hote === null) throw new Error(`hôte inconnu : ${hostId}`);
  const url = `${hote.url}/api/sandbox/import`;
  const relais = await entetesRelais(hote, uid);
  const limite = randomBytes(16).toString("hex");
  const corps = Buffer.concat([
    Buffer.from(
      `--${limite}\r\nContent-Disposition: form-data; name="archive"; filename="work.tar.gz"\r\n` +
        "Content-Type: application/gzip\r\n\r\n",
    ),
    archive,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
  const delai = DELAI_MIGRATION_S * 1000;
  const agent = new Agent({ connect: { timeout: delai }, headersTimeout: delai, bodyTimeout: delai });
  let r: Dispatcher.ResponseData;
  let contenu: Buffer;
  try {
    r = await request(url, {
      dispatcher: agent,
      method: "POST",
      headers: { ...relais, "content-type": `multipart/form-data; boundary=${limite}` },
      body: corps,
    });
    contenu = Buffer.from(await r.body.arrayBuffer());
  } finally {
    void agent.destroy();
  }
  const entetes = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (typeof v === "string") entetes.set(k, v);
  raiseForStatus({
    statusCode: r.statusCode,
    headers: entetes,
    request: { method: "POST", url },
    reasonPhrase: getReasonPhrase(r.statusCode),
    text: contenu.toString("utf8"),
  });
  return intPy(ouPy(getPy(ouPy(pyJsonLoads(texteJsonPy(contenu)), {}), "files"), 0));
}

/** `migrate_user` : `/work` exporté de l'hôte actuel, importé sur `vers`, puis réaffecté (l'ancien n'est pas détruit) ; miroir des skills poussé au mieux. */
export async function migrateUser(
  uid: number,
  vers: string,
  synchroniserMiroir: (uid: number) => Promise<void>,
): Promise<Dict> {
  const source = await placementOf(uid);
  if (source === vers) return { ok: true, moved: false, from: source, to: vers, files: 0 };
  const archive = await exporterTravail(uid, source || hoteParDefaut());
  const n = await importerTravail(uid, vers, archive);
  await assign(uid, vers);
  try {
    await synchroniserMiroir(uid);
  } catch {
    // best-effort, comme le Python
  }
  return { ok: true, moved: true, from: source, to: vers, files: n, bytes: archive.length };
}
