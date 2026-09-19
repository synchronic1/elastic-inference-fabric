import argparse
import importlib.util
import io
import json
from contextlib import redirect_stdout
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import pytest

SCRIPT = Path(__file__).parents[1] / "bin" / "fabric"
SPEC = importlib.util.spec_from_loader("fabric_cli", SourceFileLoader("fabric_cli", str(SCRIPT)))
fabric = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fabric)


def test_explicit_identity_never_uses_ambient_admin_token():
    with patch.dict("os.environ", {"GANGLION_FABRIC_TOKEN": "ambient-admin-secret"}):
        with patch.object(
            fabric.subprocess,
            "run",
            return_value=Mock(returncode=0, stdout="fat_test-node-secret\n"),
        ) as keychain:
            assert fabric.credential(identity="node-peter") == "fat_test-node-secret"
            assert keychain.call_args.args[0][3] == "ganglion.fabric/identity/node-peter"


def test_default_environment_credential_needs_no_keychain():
    with patch.dict("os.environ", {"GANGLION_FABRIC_TOKEN": "ambient-admin-secret"}):
        with patch.object(fabric.subprocess, "run") as keychain:
            assert fabric.credential() == "ambient-admin-secret"
            keychain.assert_not_called()


@pytest.mark.parametrize("name", ['bad"name', "../elsewhere", "", "a" * 65, "x\ny"])
def test_identity_names_cannot_inject_keychain_commands(name):
    with pytest.raises(ValueError):
        fabric.identity_service(name)


def test_keychain_secret_only_appears_on_captured_stdin():
    token = "fat_" + "A" * 43
    with patch.object(fabric.subprocess, "run", return_value=Mock(returncode=0)) as command:
        with patch.object(fabric, "credential", return_value=token):
            fabric.store_credential(token, "agent-test")
    assert token not in str(command.call_args.args)
    assert token in command.call_args.kwargs["input"]
    assert command.call_args.kwargs["capture_output"] is True


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com/path",
        "https://example.com?q=x",
    ],
)
def test_rejects_credential_leaking_origins(origin):
    with pytest.raises(ValueError):
        fabric.validate_origin(origin)


def test_request_refuses_redirects_and_redacts_server_errors():
    assert fabric.NoRedirect().redirect_request(None, None, 302, None, None, "https://evil") is None
    failure = HTTPError("https://fabric.test", 401, "oops", {}, io.BytesIO(b"reflected-secret"))
    with patch.object(fabric, "build_opener") as opener:
        opener.return_value.open.side_effect = failure
        with pytest.raises(ValueError, match="Fabric returned HTTP 401") as error:
            fabric.api_request("https://fabric.test", "/api/me", "test-secret")
        assert "reflected-secret" not in str(error.value)


def test_issue_persists_secret_but_only_prints_metadata():
    args = argparse.Namespace(
        name="agent-test",
        label=None,
        role="agent",
        days=1,
        node_id=None,
        origin="https://fabric.test",
    )
    issued = {"token": "fat_" + "A" * 43, "access": {"id": "test-id", "role": "agent"}}
    output = io.StringIO()
    with patch.object(fabric, "credential", return_value=None):
        with patch.object(fabric, "api_request", return_value=issued):
            with patch.object(fabric, "store_credential") as store, redirect_stdout(output):
                fabric.issue_token(args, "issuer-secret")
    store.assert_called_once_with(issued["token"], "agent-test")
    assert issued["token"] not in output.getvalue()
    assert json.loads(output.getvalue())["access"]["id"] == "test-id"


@pytest.mark.parametrize("no_expiry, expected", [(False, 30), (True, None)])
def test_issue_token_non_expiry_is_explicit(no_expiry, expected):
    args = argparse.Namespace(
        name="demo", label="Demo", role="agent", days=30, no_expiry=no_expiry,
        node_id=None, origin="https://fabric.test",
    )
    issued = {"token": "fat_" + "A" * 43, "access": {"id": "test-id"}}
    with patch.object(fabric, "credential", return_value=None):
        with patch.object(fabric, "api_request", return_value=issued) as api:
            with patch.object(fabric, "store_credential"), redirect_stdout(io.StringIO()):
                fabric.issue_token(args, "issuer-secret")
    assert api.call_args.args[3]["expires_in_days"] == expected


def test_failed_keychain_save_revokes_just_issued_token():
    args = argparse.Namespace(
        name="agent-test",
        label=None,
        role="agent",
        days=1,
        node_id=None,
        origin="https://fabric.test",
    )
    issued = {"token": "fat_" + "A" * 43, "access": {"id": "test-id"}}
    with patch.object(fabric, "credential", return_value=None):
        with patch.object(fabric, "api_request", side_effect=[issued, {"ok": True}]) as api:
            with patch.object(fabric, "store_credential", side_effect=ValueError("save failed")):
                with pytest.raises(ValueError, match="save failed"):
                    fabric.issue_token(args, "issuer-secret")
    assert api.call_args.args[1] == "/api/tokens/test-id"
    assert api.call_args.kwargs["method"] == "DELETE"
