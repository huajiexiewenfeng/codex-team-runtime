"""Lightweight deterministic team-role context lookup."""

from .core import ContextError, ContextRegistry, initialize_index

__all__ = ["ContextError", "ContextRegistry", "initialize_index"]
