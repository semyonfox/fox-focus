"""Service-token provider for the Fox Focus Kanban completion bridge."""

from __future__ import annotations

import hmac
import os
import stat
from pathlib import Path
from typing import Optional

from hermes_constants import get_hermes_home
from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    LoginStart,
    Session,
    TokenPrincipal,
)
from hermes_cli.dashboard_auth.token_auth import register_token_route


ROUTE_PATH = "/api/plugins/fox-focus-sync/task-completion"
REQUIRED_SCOPE = "kanban:personal-tasks:complete"
TOKEN_RELATIVE_PATH = Path("secrets/fox-focus-action-token")
LAST_SKIP_REASON = ""


def token_path() -> Path:
    return get_hermes_home() / TOKEN_RELATIVE_PATH


def _read_service_token(path: Path) -> tuple[Optional[str], Optional[str]]:
    """Read a long token from an owner-only regular file without following links."""
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None, f"token file is missing: {path}"
    except OSError as exc:
        return None, f"token file could not be opened safely: {exc}"

    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None, "token path is not a regular file"
        if os.name == "posix":
            if stat.S_IMODE(info.st_mode) != 0o600:
                return None, "token file permissions must be exactly 0600"
            if info.st_uid != os.getuid():
                return None, "token file must be owned by the Hermes process user"
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = -1
            raw = handle.read(4097)
    except (OSError, UnicodeError) as exc:
        return None, f"token file could not be read: {exc}"
    finally:
        if fd >= 0:
            os.close(fd)

    if len(raw) > 4096:
        return None, "token file is unexpectedly large"
    token = raw.strip()
    if len(token) < 43 or len(set(token)) < 16:
        return None, "token must be a long, randomly generated value"
    return token, None


class FoxFocusActionTokenProvider(DashboardAuthProvider):
    name = "fox-focus-action-token"
    display_name = "Fox Focus task actions"
    supports_token = True
    supports_session = False

    def __init__(self, token: str) -> None:
        self._token = token

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        if token and hmac.compare_digest(
            token.encode("utf-8"),
            self._token.encode("utf-8"),
        ):
            return TokenPrincipal(
                principal="fox-focus",
                provider=self.name,
                scopes=(REQUIRED_SCOPE,),
            )
        return None

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise NotImplementedError("This is a non-interactive service credential")

    def complete_login(
        self,
        *,
        code: str,
        state: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> Session:
        raise NotImplementedError("This is a non-interactive service credential")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        return None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise NotImplementedError("This is a non-interactive service credential")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


def register(ctx) -> None:
    """Register the fixed scoped route and its file-backed token provider."""
    global LAST_SKIP_REASON
    # Register even when the credential is absent. The route then fails closed
    # instead of falling back to a dashboard session cookie.
    register_token_route(ROUTE_PATH, required_scopes=(REQUIRED_SCOPE,))
    token, error = _read_service_token(token_path())
    if token is None:
        LAST_SKIP_REASON = error or "service token unavailable"
        return
    LAST_SKIP_REASON = ""
    ctx.register_dashboard_auth_provider(FoxFocusActionTokenProvider(token))
