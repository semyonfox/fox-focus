"""Fixed, token-scoped Fox Focus completion endpoint."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from hermes_cli import kanban_db
from hermes_cli.dashboard_auth.token_auth import register_token_route


BOARD = "personal-tasks"
ROUTE_PATH = "/api/plugins/fox-focus-sync/task-completion"
REQUIRED_SCOPE = "kanban:personal-tasks:complete"

register_token_route(ROUTE_PATH, required_scopes=(REQUIRED_SCOPE,))
router = APIRouter()


class CompletionChange(BaseModel):
    status: str = Field(min_length=1, max_length=16)

    class Config:
        extra = "forbid"


class CompletionRequest(BaseModel):
    task_id: str = Field(alias="taskId", min_length=1, max_length=200)
    expected_version: int = Field(alias="expectedVersion", ge=0)
    idempotency_key: str = Field(alias="idempotencyKey", min_length=8, max_length=200)
    approval_id: str = Field(alias="approvalId", min_length=1, max_length=200)
    change: CompletionChange

    class Config:
        extra = "forbid"


def _response(result: kanban_db.ExternalTaskCompletionResult) -> dict[str, Any]:
    return {
        "board": result.board,
        "taskId": result.task_id,
        "before": result.before,
        "after": result.after,
        "version": result.version,
        "idempotencyKey": result.idempotency_key,
        "approvalId": result.approval_id,
        "replayed": result.replayed,
    }


@router.post("/task-completion")
def complete_task(payload: CompletionRequest, request: Request):
    principal = getattr(request.state, "token_principal", None)
    if principal is None or not getattr(request.state, "token_authenticated", False):
        return JSONResponse(
            {"error": "unauthenticated", "detail": "Unauthorized"},
            status_code=401,
        )
    if REQUIRED_SCOPE not in set(getattr(principal, "scopes", ()) or ()):
        return JSONResponse(
            {"error": "insufficient_scope", "detail": "Forbidden"},
            status_code=403,
        )
    if payload.change.status != "done":
        return JSONResponse(
            {
                "error": "unsupported_change",
                "detail": "Only change.status='done' is supported",
            },
            status_code=400,
        )

    kanban_db.init_db(board=BOARD)
    conn = kanban_db.connect(board=BOARD)
    try:
        result = kanban_db.complete_task_from_external_approval(
            conn,
            payload.task_id,
            board=BOARD,
            principal=str(getattr(principal, "principal", "")),
            expected_version=payload.expected_version,
            idempotency_key=payload.idempotency_key,
            approval_id=payload.approval_id,
        )
        return _response(result)
    except kanban_db.ExternalTaskNotFoundError as exc:
        return JSONResponse(
            {"error": "task_not_found", "detail": str(exc)},
            status_code=404,
        )
    except kanban_db.ExternalTaskVersionConflict as exc:
        return JSONResponse(
            {
                "error": "version_conflict",
                "detail": str(exc),
                "current": exc.current,
                "currentVersion": exc.current["version"],
            },
            status_code=409,
        )
    except kanban_db.ExternalTaskStateConflict as exc:
        return JSONResponse(
            {
                "error": "state_conflict",
                "detail": str(exc),
                "current": exc.current,
                "currentVersion": exc.current["version"],
            },
            status_code=409,
        )
    except kanban_db.ExternalTaskIdempotencyConflict as exc:
        return JSONResponse(
            {"error": "idempotency_conflict", "detail": str(exc)},
            status_code=409,
        )
    except ValueError as exc:
        return JSONResponse(
            {"error": "invalid_request", "detail": str(exc)},
            status_code=400,
        )
    finally:
        conn.close()
