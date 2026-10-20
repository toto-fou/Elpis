# SPDX-License-Identifier: MIT
# rag_app/extracteur/erreurs.py — erreur typée portée jusqu'à la ligne NDJSON ou à la réponse HTTP.

CODES_EXTRACTION = ("no_text", "encrypted", "unsupported", "too_large", "timeout", "corrupt", "ocr_unavailable")


class ErreurExtracteur(Exception):
    def __init__(self, code: str, message: str, http: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http = http

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message}
