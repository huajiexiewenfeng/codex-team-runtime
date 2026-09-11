"""Narrow stdio MCP transport for deterministic team-context lookup."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

from mcp.server.mcpserver import MCPServer
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from .core import ContextError, ContextRegistry, initialize_index
from .team_registry import TeamRegistry, initialize_registry


def _json_result(value: Any, *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[
            TextContent(
                type="text",
                text=json.dumps(value, ensure_ascii=False, separators=(",", ":")),
            )
        ],
        isError=is_error,
    )


def create_server(
    *,
    registry_path: str | Path | None = None,
    index_path: str | Path | None = None,
    state_roots: list[str | Path] | None = None,
    node_executable: str | Path | None = None,
    runtime_root: str | Path | None = None,
) -> MCPServer:
    """Create one transport instance without initializing or mutating its index."""

    if registry_path is not None:
        if index_path is not None or state_roots is not None:
            raise ContextError(
                "INVALID_MODE", "--registry cannot be combined with --index or --state-root"
            )
        registry: TeamRegistry | ContextRegistry = TeamRegistry(
            registry_path=registry_path,
            node_executable=node_executable,
            runtime_root=runtime_root,
        )
        registry_mode = True
    elif index_path is not None and state_roots:
        if node_executable is not None or runtime_root is not None:
            raise ContextError(
                "INVALID_MODE", "Runtime link configuration is only valid with --registry"
            )
        registry = ContextRegistry(index_path=index_path, state_roots=state_roots)
        registry_mode = False
    else:
        raise ContextError(
            "INVALID_MODE",
            "Use exactly one mode: --registry, or --index with at least one --state-root",
        )

    server = MCPServer(name="codex-team-context", version="0.1.0", instructions=None)

    @server.tool(
        name="team_context.read",
        description=(
            "Read registered role, team, and leader context for an exact host and task "
            "identity; an unknown identity returns JSON null."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def read(host_id: str, thread_id: str) -> CallToolResult:
        try:
            return _json_result(registry.read(host_id, thread_id))
        except ContextError as exc:
            return _json_result(exc.as_dict(), is_error=True)

    if registry_mode:
        team_registry = cast(TeamRegistry, registry)

        @server.tool(
            name="team_context.manage",
            description="Apply one authorized, idempotent team registry operation.",
            annotations=ToolAnnotations(
                readOnlyHint=False,
                destructiveHint=True,
                idempotentHint=True,
                openWorldHint=False,
            ),
        )
        def manage(
            actor_host_id: str, actor_thread_id: str, request: dict[str, Any]
        ) -> CallToolResult:
            try:
                return _json_result(
                    team_registry.manage(actor_host_id, actor_thread_id, request)
                )
            except ContextError as exc:
                return _json_result(exc.as_dict(), is_error=True)

    return server


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="codex-team-context")
    subcommands = parser.add_subparsers(dest="command", required=True)

    initialize = subcommands.add_parser("init", help="create a new empty context index")
    initialize.add_argument("--registry")
    initialize.add_argument("--index")

    serve = subcommands.add_parser("serve", help="serve the context registry over stdio")
    serve.add_argument("--registry")
    serve.add_argument("--index")
    serve.add_argument("--state-root", action="append", dest="state_roots")
    serve.add_argument("--node-executable")
    serve.add_argument("--runtime-root")
    return parser


def _path_mode(args: argparse.Namespace) -> str:
    if args.registry is not None:
        if args.index is not None or getattr(args, "state_roots", None) is not None:
            raise ContextError(
                "INVALID_MODE", "--registry cannot be combined with --index or --state-root"
            )
        return "registry"
    if args.index is None:
        raise ContextError("INVALID_MODE", "Exactly one of --registry or --index is required")
    if args.command == "serve" and not args.state_roots:
        raise ContextError("INVALID_MODE", "Legacy --index mode requires --state-root")
    return "index"


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        mode = _path_mode(args)
        if args.command == "init":
            if mode == "registry":
                initialize_registry(args.registry)
            else:
                initialize_index(args.index)
            return 0

        if mode == "registry":
            server = create_server(
                registry_path=args.registry,
                node_executable=args.node_executable,
                runtime_root=args.runtime_root,
            )
        else:
            server = create_server(index_path=args.index, state_roots=args.state_roots)
        server.run("stdio")
        return 0
    except ContextError as exc:
        print(json.dumps(exc.as_dict(), ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
