# SPDX-License-Identifier: MIT
"""Low-level OOXML helpers layered on top of python-docx's lxml tree.

Everything python-docx cannot express natively — charts, fields, watermarks,
footnotes, section plumbing — is built here by writing WordprocessingML directly.
"""
