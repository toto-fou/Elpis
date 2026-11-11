// SPDX-License-Identifier: MIT
// tests/frontend/aides-bac.mjs — réponses des routes du bac (/api/sandbox/*) des serveurs factices, dans la forme des contrats C2 (packages/contracts/src/rest/bac-*.ts).

export const SHA = 'a'.repeat(64);

export const arbre = (items, extra = {}) => ({ root: 'work', items, truncated: false, max_entries: 20000, ...extra });
export const quota = (extra = {}) => ({ used_mb: 0, quota_mb: 0, pct: 0, used_bytes: 0, quota_bytes: 0, remaining_bytes: null, ...extra });
export const sauvegarde = (extra = {}) => ({ ok: true, size: 0, mtime: 1, sha256: SHA, ...extra });
export const etats = (stale = []) => ({ stale, truncated: false });
export const precontrole = (extra = {}) => ({
    fits: true, reason: '', allowed_bytes: null, needed_bytes: 0, total_bytes: 0, overwrite_bytes: 0, escaped: 0, detailed: true,
    unlimited: true, quota_bytes: 0, used_bytes: 0, remaining_bytes: null, limit_bytes: null, max_pct: 60, ...extra,
});
export const envoi = (extra = {}) => ({ ok: true, saved: 0, skipped: [], mtimes: {}, sha256s: {}, ...extra });
export const morceau = (fini) => (fini ? { ok: true, done: true, path: 'f', mtime: 1, sha256: SHA } : { ok: true, done: false });
export const profil = (id, name, mode, extra = {}) => ({ id, name, mode, ips: [], description: '', domains: [], ports: [], dns: [], ...extra });
export const moi = (container = { exists: true, running: true, container_name: 'elpis-sb-alice' }, extra = {}) => ({
    user_mode: 'docker', effective_mode: 'docker', force_admin: false, image: 'elpis/sandbox:test',
    limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 }, idle_kill_hours: 24,
    image_status: { status: 'loaded', image: 'elpis/sandbox:test', archive_path: null, progress_msg: '' },
    network_profile_id: 'isolated', network_profiles: [profil('isolated', 'Isolé', 'none')], network_profile_locked: false,
    daemon_ok: true, daemon_info: '', container, ...extra,
});
export const choix = (container = { running: true, container_name: 'elpis-sb-alice' }, extra = {}) => ({
    ok: true, mode: 'docker', network_profile_id: 'isolated', bootstrap: { image_status: moi().image_status, container }, ...extra,
});
