# SPDX-License-Identifier: MIT
"""Dépôt Git « distant » pour les tests du relais (L4.4) : ``git http-backend``
en CGI derrière un serveur HTTP local, qui exige ``BASIC`` si ``auth``."""
from __future__ import annotations

import base64
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JETON = "jeton-secret"
BASIC = "Basic " + base64.b64encode(f"u:{JETON}".encode()).decode()


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd,
                   check=True, capture_output=True)


class _Amont(BaseHTTPRequestHandler):
    """``git http-backend`` en CGI ; exige ``BASIC`` si ``server.auth``."""

    def log_message(self, *a):
        pass

    def _cgi(self):
        srv = self.server
        srv.vus.append((self.command, self.path, self.headers.get("Authorization")))
        if srv.auth and self.headers.get("Authorization") != BASIC:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="t"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        chemin, _, requete = self.path.partition("?")
        corps = b""
        if self.command == "POST":
            if "chunked" in (self.headers.get("Transfer-Encoding") or ""):
                morceaux = []
                while (n := int(self.rfile.readline().split(b";")[0], 16)):
                    morceaux.append(self.rfile.read(n))
                    self.rfile.readline()
                self.rfile.readline()
                corps = b"".join(morceaux)
            else:
                corps = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        env = {"PATH": os.environ["PATH"], "GIT_PROJECT_ROOT": srv.racine,
               "GIT_HTTP_EXPORT_ALL": "1", "PATH_INFO": chemin, "QUERY_STRING": requete,
               "REQUEST_METHOD": self.command, "CONTENT_LENGTH": str(len(corps)),
               "CONTENT_TYPE": self.headers.get("Content-Type") or "", "REMOTE_USER": "u",
               "REMOTE_ADDR": "127.0.0.1", "HOME": srv.racine, "GIT_CONFIG_NOSYSTEM": "1",
               "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding") or "",
               "GIT_PROTOCOL": self.headers.get("Git-Protocol") or ""}
        p = subprocess.run(["git", "http-backend"], input=corps, env=env, capture_output=True,
                           timeout=30)
        tete, _, reste = p.stdout.partition(b"\r\n\r\n")
        statut, entetes = 200, []
        for ligne in tete.decode().split("\r\n"):
            k, _, v = ligne.partition(":")
            if k.lower() == "status":
                statut = int(v.split()[0])
            elif k:
                entetes.append((k, v.strip()))
        self.send_response(statut)
        for k, v in entetes:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(reste)))
        self.end_headers()
        self.wfile.write(reste)

    do_GET = do_POST = _cgi


def demarrer_amont(tmp_path, auth=True):
    """Serveur (``url``, ``racine``, ``src``, ``vus``) d'un dépôt ``depot.git``
    à un commit ; à arrêter par ``shutdown()`` puis ``server_close()``."""
    racine = tmp_path / "amont"
    src = tmp_path / "src"
    src.mkdir()
    _git(src, "init", "-q", "-b", "main")
    (src / "a.txt").write_text("a\n")
    _git(src, "add", "a.txt")
    _git(src, "commit", "-q", "-m", "a")
    racine.mkdir()
    _git(racine, "init", "-q", "--bare", "depot.git")
    _git(src, "push", "-q", str(racine / "depot.git"), "main")
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Amont)
    srv.racine, srv.auth, srv.vus, srv.src = str(racine), auth, [], src
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    srv.url = f"http://127.0.0.1:{srv.server_address[1]}/depot.git"
    return srv
