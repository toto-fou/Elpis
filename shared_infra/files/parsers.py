# SPDX-License-Identifier: MIT
"""
backend/file_parsers.py — Parseurs de fichiers binaires pour analyse LLM.

Convertit les fichiers réseau (pcap, pcapng, etc.) en JSON structuré
pour que le modèle puisse analyser le trafic.

Dépendance : dpkt (installée automatiquement au premier appel)

Usage:
    from shared_infra.file_parsers import parse_file, SUPPORTED_EXTENSIONS
    result_json = parse_file(file_bytes, "capture.pcap")
"""
from __future__ import annotations

import json
import logging
import socket
import struct
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

logger = logging.getLogger("uvicorn.error")

SUPPORTED_EXTENSIONS = {".pcap", ".pcapng", ".cap"}


def parse_file(data: bytes, filename: str) -> str:
    """Parse a binary file and return structured JSON string."""
    ext = _get_ext(filename)
    if ext in (".pcap", ".pcapng", ".cap"):
        return parse_pcap(data, filename)
    return json.dumps({"error": f"Format non supporté : {ext}"})


def _get_ext(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot >= 0 else ""


def _ensure_dpkt() -> bool:
    """Install dpkt if not available. Tries local wheels/ first, then PyPI."""
    try:
        import dpkt  # noqa: F401  (disponibilité seulement)
        return True
    except ImportError:
        pass
    # Look for local wheel in wheels/ directory (offline install)
    from pathlib import Path
    wheels_dir = Path(__file__).resolve().parent.parent / "wheels"
    local_whl = None
    if wheels_dir.is_dir():
        for f in wheels_dir.iterdir():
            if f.name.startswith("dpkt") and f.suffix == ".whl":
                local_whl = str(f)
                break
    try:
        if local_whl:
            logger.info(f"[FILE_PARSERS] Installation de dpkt depuis {local_whl}")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", local_whl,
                 "--break-system-packages", "-q", "--no-deps"],
                timeout=60
            )
        else:
            logger.info("[FILE_PARSERS] Installation de dpkt depuis PyPI…")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "dpkt",
                 "--break-system-packages", "-q"],
                timeout=60
            )
        return True
    except Exception as e:
        logger.warning(f"[FILE_PARSERS] Impossible d'installer dpkt: {e}")
        return False


# ─── Port / protocol maps ───────────────────────────────────────

_PORT_NAMES = {
    20: "FTP-Data", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP",
    53: "DNS", 67: "DHCP", 68: "DHCP", 80: "HTTP", 110: "POP3",
    123: "NTP", 143: "IMAP", 443: "HTTPS", 445: "SMB", 993: "IMAPS",
    995: "POP3S", 3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL",
    5900: "VNC", 6379: "Redis", 8080: "HTTP-Alt", 8443: "HTTPS-Alt",
    27017: "MongoDB", 5353: "mDNS",
}

_IP_PROTO = {
    1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 41: "IPv6-tun",
    47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6", 89: "OSPF",
}

_DNS_TYPES = {1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR",
              15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 65: "HTTPS"}

def _inc(d: dict, key):
    d[key] = d.get(key, 0) + 1


# ─── Main parser ────────────────────────────────────────────────

def parse_pcap(data: bytes, filename: str) -> str:
    """Parse pcap/pcapng into structured JSON using dpkt."""
    if not _ensure_dpkt():
        return json.dumps({"error": "Bibliothèque dpkt non disponible. pip install dpkt"})

    import io

    import dpkt

    reader = None
    try:
        reader = dpkt.pcapng.Reader(io.BytesIO(data))
    except Exception:
        try:
            reader = dpkt.pcap.Reader(io.BytesIO(data))
        except Exception as e:
            return json.dumps({"error": f"Fichier invalide: {e}"})

    packets: List[Dict] = []
    stats: Dict[str, Any] = {
        "protocols": {}, "src_ips": {}, "dst_ips": {},
        "conversations": {}, "ports": {},
        "dns_queries": [], "http_requests": [], "tls_hosts": [],
    }
    first_ts = last_ts = None
    errors = pkt_count = 0
    MAX_DETAIL = 500

    for ts, buf in reader:
        pkt_count += 1
        if first_ts is None: first_ts = ts
        last_ts = ts

        pkt: Dict[str, Any] = {"n": pkt_count, "t": round(ts - (first_ts or 0), 6), "len": len(buf)}

        try:
            eth = dpkt.ethernet.Ethernet(buf)
        except Exception:
            errors += 1
            pkt["proto"] = "?"
            if pkt_count <= MAX_DETAIL: packets.append(pkt)
            continue

        # ── ARP ──
        if isinstance(eth.data, dpkt.arp.ARP):
            arp = eth.data
            try:    spa, tpa = socket.inet_ntoa(arp.spa), socket.inet_ntoa(arp.tpa)
            except Exception: spa, tpa = "?", "?"
            op = "Request" if arp.op == 1 else "Reply" if arp.op == 2 else f"op={arp.op}"
            pkt["proto"] = "ARP"
            pkt["info"] = f"{op} {spa} → {tpa}"
            _inc(stats["protocols"], "ARP")
            if pkt_count <= MAX_DETAIL: packets.append(pkt)
            continue

        # ── IP ──
        ip = eth.data
        if not isinstance(ip, (dpkt.ip.IP, dpkt.ip6.IP6)):
            pkt["proto"] = f"Eth/0x{eth.type:04x}"
            _inc(stats["protocols"], pkt["proto"])
            if pkt_count <= MAX_DETAIL: packets.append(pkt)
            continue

        if isinstance(ip, dpkt.ip.IP):
            src_ip, dst_ip = socket.inet_ntoa(ip.src), socket.inet_ntoa(ip.dst)
        else:
            src_ip = socket.inet_ntop(socket.AF_INET6, ip.src)
            dst_ip = socket.inet_ntop(socket.AF_INET6, ip.dst)

        pkt["src"] = src_ip
        pkt["dst"] = dst_ip
        _inc(stats["src_ips"], src_ip)
        _inc(stats["dst_ips"], dst_ip)
        _inc(stats["conversations"], " ↔ ".join(sorted([src_ip, dst_ip])))

        transport = ip.data

        # ── ICMP ──
        if isinstance(transport, (dpkt.icmp.ICMP,)):
            _ICMP = {0: "Echo Reply", 3: "Dest Unreachable", 8: "Echo Request", 11: "Time Exceeded"}
            pkt["proto"] = "ICMP"
            pkt["info"] = _ICMP.get(transport.type, f"type={transport.type}")
            _inc(stats["protocols"], "ICMP")
            if pkt_count <= MAX_DETAIL: packets.append(pkt)
            continue

        # ── TCP ──
        if isinstance(transport, dpkt.tcp.TCP):
            sp, dp = transport.sport, transport.dport
            pkt["sport"], pkt["dport"] = sp, dp
            _inc(stats["ports"], sp); _inc(stats["ports"], dp)

            fl = []
            if transport.flags & dpkt.tcp.TH_SYN: fl.append("SYN")
            if transport.flags & dpkt.tcp.TH_ACK: fl.append("ACK")
            if transport.flags & dpkt.tcp.TH_FIN: fl.append("FIN")
            if transport.flags & dpkt.tcp.TH_RST: fl.append("RST")
            if transport.flags & dpkt.tcp.TH_PUSH: fl.append("PSH")
            if fl: pkt["flags"] = ",".join(fl)

            payload = bytes(transport.data) if transport.data else b""
            proto = _detect_app_proto(sp, dp, payload, pkt, stats)
            pkt["proto"] = proto
            _inc(stats["protocols"], proto)
            svc = _PORT_NAMES.get(sp) or _PORT_NAMES.get(dp)
            if svc: pkt["svc"] = svc

        # ── UDP ──
        elif isinstance(transport, dpkt.udp.UDP):
            sp, dp = transport.sport, transport.dport
            pkt["sport"], pkt["dport"] = sp, dp
            _inc(stats["ports"], sp); _inc(stats["ports"], dp)

            payload = bytes(transport.data) if transport.data else b""
            proto = _detect_app_proto(sp, dp, payload, pkt, stats)
            pkt["proto"] = proto
            _inc(stats["protocols"], proto)
            svc = _PORT_NAMES.get(sp) or _PORT_NAMES.get(dp)
            if svc: pkt["svc"] = svc

        else:
            pn = ip.p if isinstance(ip, dpkt.ip.IP) else ip.nxt
            proto = _IP_PROTO.get(pn, f"IP/{pn}")
            pkt["proto"] = proto
            _inc(stats["protocols"], proto)

        if pkt_count <= MAX_DETAIL:
            packets.append(pkt)

    # ── Build result ──
    result: Dict[str, Any] = {"file": filename, "total_packets": pkt_count}

    if first_ts and last_ts:
        try:
            result["start"] = datetime.fromtimestamp(first_ts, tz=timezone.utc).isoformat()
            result["end"] = datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat()
            result["duration_sec"] = round(last_ts - first_ts, 3)
        except Exception: pass

    if errors: result["errors"] = errors

    result["protocols"] = dict(sorted(stats["protocols"].items(), key=lambda x: -x[1]))

    all_ips: Dict[str, int] = {}
    for ip, c in list(stats["src_ips"].items()) + list(stats["dst_ips"].items()):
        all_ips[ip] = all_ips.get(ip, 0) + c
    result["top_ips"] = [{"ip": k, "pkts": v} for k, v in sorted(all_ips.items(), key=lambda x: -x[1])[:25]]
    result["top_ports"] = [{"port": p, "svc": _PORT_NAMES.get(p, ""), "pkts": c} for p, c in sorted(stats["ports"].items(), key=lambda x: -x[1])[:20]]
    result["conversations"] = [{"pair": k, "pkts": v} for k, v in sorted(stats["conversations"].items(), key=lambda x: -x[1])[:20]]

    if stats["dns_queries"]:
        result["dns"] = stats["dns_queries"][:100]
    if stats["http_requests"]:
        result["http"] = stats["http_requests"][:50]
    if stats["tls_hosts"]:
        result["tls_hosts"] = sorted(set(stats["tls_hosts"]))[:50]

    result["packets"] = packets
    if pkt_count > MAX_DETAIL:
        result["note"] = f"{MAX_DETAIL} paquets détaillés sur {pkt_count}"

    return json.dumps(result, ensure_ascii=False)


# ─── Application layer detection ────────────────────────────────

def _detect_app_proto(sp: int, dp: int, payload: bytes, pkt: dict, stats: dict) -> str:
    """Detect application protocol from ports + payload."""
    # DNS
    if sp == 53 or dp == 53 or sp == 5353 or dp == 5353:
        _parse_dns(payload, pkt, stats)
        return "DNS" if dp == 53 or sp == 53 else "mDNS"
    # HTTP
    if dp in (80, 8080) or sp in (80, 8080):
        return _parse_http(payload, pkt, stats)
    # TLS/HTTPS
    if dp in (443, 8443) or sp in (443, 8443):
        return _parse_tls(payload, pkt, stats)
    # DHCP
    if dp in (67, 68) or sp in (67, 68):
        return "DHCP"
    # NTP
    if dp == 123 or sp == 123:
        return "NTP"
    # SSH
    if dp == 22 or sp == 22:
        return "SSH"
    # Known port?
    svc_d = _PORT_NAMES.get(dp)
    svc_s = _PORT_NAMES.get(sp)
    if svc_d: return svc_d
    if svc_s: return svc_s
    return "TCP" if dp != sp else "UDP"


def _parse_dns(payload: bytes, pkt: dict, stats: dict):
    if not payload or len(payload) < 12: return
    try:
        import dpkt
        dns = dpkt.dns.DNS(payload)
        queries = []
        for q in dns.qd:
            qt = _DNS_TYPES.get(q.type, f"type{q.type}")
            queries.append({"name": q.name, "type": qt})
        answers = []
        for rr in dns.an:
            entry = {"name": rr.name, "type": _DNS_TYPES.get(rr.type, f"type{rr.type}")}
            if rr.type == 1 and len(rr.rdata) == 4:
                entry["data"] = socket.inet_ntoa(rr.rdata)
            elif rr.type == 28 and len(rr.rdata) == 16:
                entry["data"] = socket.inet_ntop(socket.AF_INET6, rr.rdata)
            elif rr.type == 5:
                entry["data"] = rr.cname
            answers.append(entry)
        if queries: pkt["dns_q"] = queries
        if answers: pkt["dns_a"] = answers
        stats["dns_queries"].extend([{"name": q["name"], "type": q["type"]} for q in queries[:5]])
    except Exception: pass


def _parse_http(payload: bytes, pkt: dict, stats: dict) -> str:
    if not payload: return "HTTP"
    try:
        import dpkt
        try:
            req = dpkt.http.Request(payload)
            entry = {"method": req.method, "uri": req.uri[:200]}
            host = req.headers.get("host", "")
            if host: entry["host"] = host
            pkt["http"] = entry
            stats["http_requests"].append(entry)
            return "HTTP"
        except Exception: pass
        try:
            resp = dpkt.http.Response(payload)
            pkt["http"] = {"status": resp.status, "reason": resp.reason}
            return "HTTP"
        except Exception: pass
    except Exception: pass
    return "HTTP"


def _parse_tls(payload: bytes, pkt: dict, stats: dict) -> str:
    if not payload or len(payload) < 6: return "TLS"
    if payload[0] != 0x16: return "TLS"
    sni = _extract_sni(payload)
    if sni:
        pkt["tls_sni"] = sni
        stats["tls_hosts"].append(sni)
    return "TLS"


def _extract_sni(data: bytes) -> str:
    """Extract SNI from TLS ClientHello."""
    try:
        if len(data) < 44 or data[0] != 0x16: return ""
        hs = data[5:]
        if not hs or hs[0] != 1: return ""
        off = 4 + 2 + 32
        if off >= len(hs): return ""
        sl = hs[off]; off += 1 + sl
        if off + 2 > len(hs): return ""
        cl = struct.unpack("!H", hs[off:off+2])[0]; off += 2 + cl
        if off >= len(hs): return ""
        cml = hs[off]; off += 1 + cml
        if off + 2 > len(hs): return ""
        el = struct.unpack("!H", hs[off:off+2])[0]; off += 2
        end = off + el
        while off + 4 <= end and off + 4 <= len(hs):
            et = struct.unpack("!H", hs[off:off+2])[0]
            edl = struct.unpack("!H", hs[off+2:off+4])[0]
            off += 4
            if et == 0 and edl > 5:
                so = off + 2
                if so + 3 <= off + edl and so + 3 <= len(hs):
                    nl = struct.unpack("!H", hs[so+1:so+3])[0]
                    if so + 3 + nl <= len(hs):
                        return hs[so+3:so+3+nl].decode("ascii", errors="replace")
            off += edl
    except Exception: pass
    return ""
