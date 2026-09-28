# SPDX-License-Identifier: MIT
"""Audit 2026-09-22 (H4) : une valeur client qui commence par « - » ne doit
jamais atteindre git comme option (``--output=``, ``--exec=``)."""
import pytest
from fastapi import HTTPException

from shared_infra.sandbox import routes_git as g


@pytest.mark.parametrize("v", ["--output=/tmp/x", "-x", "", "a b", "a;b", None, 3])
def test_ref_refusee(v):
    with pytest.raises(HTTPException) as e:
        g._ref_arg(v)
    assert e.value.status_code == 400


@pytest.mark.parametrize("v", ["main", "origin/main", "HEAD~1", "v1.2^", "feat-x", "a@b"])
def test_ref_acceptee(v):
    assert g._ref_arg(v) == v


@pytest.mark.parametrize("v", ["--output=/tmp/x", "HEAD", "abc", "g" * 40])
def test_hash_refuse(v):
    with pytest.raises(HTTPException):
        g._hash_arg(v)


def test_hash_accepte():
    assert g._hash_arg("a1b2c3d4" * 5) == "a1b2c3d4" * 5


def test_paths_non_liste():
    with pytest.raises(HTTPException):
        g._paths_arg("a")
    with pytest.raises(HTTPException):
        g._paths_arg([1])
