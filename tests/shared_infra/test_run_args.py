# SPDX-License-Identifier: MIT
"""Tests for the extracted, pure docker-run argv builder, incl. the opt-in
hardening flags (gVisor runtime / extra args), default OFF = status quo."""
from pathlib import Path

from shared_infra.sandbox.executors._user_sandbox import (
    UserSandbox, SandboxAdminConfig, NetworkProfile, netcfg_hash,
)


def _sandbox(cfg, profile_id="isolated"):
    return UserSandbox(1, "alice", Path("/tmp/sb/alice"), cfg=cfg,
                       network_profile_id=profile_id)


def test_default_profile_is_status_quo():
    cfg = SandboxAdminConfig.from_dict({})
    sb = _sandbox(cfg)
    args = sb._build_run_args(sb.network_profile)
    assert args[0] == "run" and "-d" in args
    assert "--runtime" not in args                 # no gVisor by default
    assert "--security-opt" in args
    assert "no-new-privileges:false" in args       # sudo must still work
    i = args.index("--cap-drop")                    # no device node in /work
    assert args[i + 1] == "MKNOD"
    assert "--network" in args and "none" in args  # isolated default
    assert args[-3:] == [cfg.image, "sleep", "infinity"]
    assert f"{cfg.memory_mb}m" in args


def test_gvisor_runtime_opt_in():
    cfg = SandboxAdminConfig.from_dict({"runtime": "runsc"})
    sb = _sandbox(cfg)
    args = sb._build_run_args(sb.network_profile)
    i = args.index("--runtime")
    assert args[i + 1] == "runsc"
    # placed before the image, after `run -d`
    assert i < args.index(cfg.image)


def test_extra_run_args_appended_before_image():
    cfg = SandboxAdminConfig.from_dict({"extra_run_args": ["--cap-add", "SYS_PTRACE"]})
    sb = _sandbox(cfg)
    args = sb._build_run_args(sb.network_profile)
    assert "SYS_PTRACE" in args
    assert args.index("SYS_PTRACE") < args.index(cfg.image)


def test_allowlist_profile_adds_net_admin():
    cfg = SandboxAdminConfig.from_dict({
        "network_profiles": [
            {"id": "isolated", "name": "Isolated", "mode": "none", "ips": []},
            {"id": "web", "name": "Web", "mode": "allowlist_ip", "ips": ["1.2.3.4"]},
        ],
    })
    sb = _sandbox(cfg, profile_id="web")
    args = sb._build_run_args(sb.network_profile)
    assert "--cap-add" in args and "NET_ADMIN" in args
    assert any(a.startswith("ELPIS_ALLOWLIST=") and "1.2.3.4" in a for a in args)


def test_allowlist_domains_ports_dns():
    """Réglage fin : domaines résolus (fournis par l'appelant) → allowlist +
    --add-host épinglé ; ports → ELPIS_ALLOWLIST_PORTS ; dns → ELPIS_DNS +
    --dns + IPs ajoutées à l'allowlist (compat image < 1.6.0)."""
    cfg = SandboxAdminConfig.from_dict({
        "network_profiles": [
            {"id": "isolated", "name": "Isolated", "mode": "none", "ips": []},
            {"id": "web", "name": "Web", "mode": "allowlist_ip",
             "ips": ["10.0.0.5"], "domains": ["github.com"],
             "ports": [443, 80], "dns": ["10.168.1.1"]},
        ],
    })
    sb = _sandbox(cfg, profile_id="web")
    args = sb._build_run_args(sb.network_profile,
                              {"github.com": ["140.82.121.3", "140.82.121.4"]})
    allow = next(a for a in args if a.startswith("ELPIS_ALLOWLIST="))
    # IPs admin + IPs résolues + résolveur, dédupliqués
    assert allow == ("ELPIS_ALLOWLIST=10.0.0.5 140.82.121.3 "
                     "140.82.121.4 10.168.1.1")
    assert "ELPIS_ALLOWLIST_PORTS=443,80" in args
    assert "ELPIS_DNS=10.168.1.1" in args
    i = args.index("--add-host")
    assert args[i + 1] == "github.com:140.82.121.3"     # épinglage 1ère IP
    j = args.index("--dns")
    assert args[j + 1] == "10.168.1.1"


def test_netcfg_label_and_hash_stability():
    """Le label elpis.netcfg porte l'empreinte de la CONFIG du profil (pas des
    IPs résolues) : stable à config égale, différent dès qu'un champ bouge."""
    cfg = SandboxAdminConfig.from_dict({
        "network_profiles": [
            {"id": "isolated", "name": "Isolated", "mode": "none", "ips": []},
            {"id": "web", "name": "Web", "mode": "allowlist_ip",
             "ips": ["1.2.3.4"], "domains": ["example.org"]},
        ],
    })
    sb = _sandbox(cfg, profile_id="web")
    prof = sb.network_profile
    expected = netcfg_hash(prof)
    args_a = sb._build_run_args(prof, {"example.org": ["9.9.9.9"]})
    args_b = sb._build_run_args(prof, {"example.org": ["8.8.8.8"]})  # rotation DNS
    assert f"elpis.netcfg={expected}" in args_a
    assert f"elpis.netcfg={expected}" in args_b        # même hash malgré la rotation
    prof2 = NetworkProfile.from_dict({**prof.to_dict(), "ports": [443]})
    assert netcfg_hash(prof2) != expected              # un champ bouge → hash bouge


def test_allowlist_without_new_fields_is_status_quo():
    """Un profil existant (sans domains/ports/dns) produit EXACTEMENT les
    mêmes flags réseau qu'avant (+ le label netcfg) — pas de --dns, pas de
    ELPIS_ALLOWLIST_PORTS, pas d'--add-host."""
    cfg = SandboxAdminConfig.from_dict({
        "network_profiles": [
            {"id": "isolated", "name": "Isolated", "mode": "none", "ips": []},
            {"id": "web", "name": "Web", "mode": "allowlist_ip", "ips": ["1.2.3.4"]},
        ],
    })
    sb = _sandbox(cfg, profile_id="web")
    args = sb._build_run_args(sb.network_profile)
    assert "ELPIS_ALLOWLIST=1.2.3.4" in args
    assert not any(a.startswith("ELPIS_ALLOWLIST_PORTS") for a in args)
    assert not any(a.startswith("ELPIS_DNS") for a in args)
    assert "--add-host" not in args and "--dns" not in args


def test_skills_not_mounted(tmp_path, monkeypatch):
    # Les skills (perso ET globaux) ne sont PLUS montés dans /work : l'agent y
    # accède uniquement via skill_get / skill_read_file / skill_run_script.
    # Même avec une bibliothèque globale présente, aucun -v vers /work/.skills
    # ni /work/skills n'est ajouté.
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    monkeypatch.setenv("APP_SKILLS_DIR", str(skills_dir))
    cfg = SandboxAdminConfig.from_dict({})
    sb = _sandbox(cfg)
    args = sb._build_run_args(sb.network_profile)
    assert not any(":/work/.skills:ro" in a for a in args)
    assert not any("/work/skills:" in a for a in args)
    # Le seul bind sur /work reste le dossier de travail (P/work) en RW.
    assert any(a.endswith(":/work:rw") for a in args)
