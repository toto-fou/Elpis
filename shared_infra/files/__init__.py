# SPDX-License-Identifier: MIT
"""
backend.files — File parsing and upload utilities.

Public surface:
  - ``parse_file(path)`` — extract text from PDFs, Word docs, spreadsheets,
                           archives, audio (whisper), code, structured data.
                           Used by the chat tool that reads sandbox files.
  - ``SUPPORTED_EXTENSIONS`` — set of extensions ``parse_file`` knows how to
                                handle (queried by the upload endpoint to
                                tell the user what's allowed).
  - ``parse_pcap(path)`` — packet-capture summariser; isolated from
                            ``parse_file`` because ``scapy`` is a heavy
                            optional dependency.
  - ``save_upload_bounded(upload, path, max_bytes)`` — persist a multipart
                                upload to disk while enforcing a size cap;
                                raises ``HTTPException`` if exceeded.
  - ``read_upload_bounded(upload, max_bytes)`` — same, but returns bytes
                                instead of writing to disk. Used by handlers
                                that want to inspect the upload before
                                committing it (e.g. JSON config validation).
  - ``assert_content_length_ok(request, max_bytes)`` — pre-flight check on
                                ``Content-Length`` before any read; cheap
                                early-exit for obviously oversized requests.

Why a package rather than two modules at root
---------------------------------------------
``parse_file`` and ``save_upload_bounded`` are used together at every
upload endpoint (read → parse → store). Grouping them here means the
endpoint handlers do a single ``from backend.files import ...`` instead
of two separate imports from disparate paths.
"""
from shared_infra.files.parsers import (
    SUPPORTED_EXTENSIONS,
    parse_file,
    parse_pcap,
)
from shared_infra.files.uploads import (
    assert_content_length_ok,
    read_upload_bounded,
    save_upload_bounded,
)

__all__ = [
    "SUPPORTED_EXTENSIONS",
    "parse_file",
    "parse_pcap",
    "assert_content_length_ok",
    "read_upload_bounded",
    "save_upload_bounded",
]
