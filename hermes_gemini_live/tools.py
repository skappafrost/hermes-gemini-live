"""The one tool this voice lane offers the model.

Deliberately a single delegate rather than Hermes' real tool list: the api_server runs
the whole toolset server-side, so shipping 30 JSON schemas into the setup frame would
spend tokens on every call to describe capabilities the model may not need, and would
still leave the voice model making fine-grained tool decisions it is not good at. One
"do this work" call, and Hermes decides how.
"""

from __future__ import annotations

DELEGATE_NAME = "hermes_task"

DESCRIPTION = (
    "Hand real work to Hermes: files, terminals, web, code, memory, anything the user's "
    "install can do. The call returns immediately with a receipt — Hermes keeps working "
    "in the background and the result is delivered to you later as a system note. After "
    "calling it, say in one short sentence that you are on it, then stay quiet until the "
    "result arrives. Never invent the result."
)

#: Gemini's functionDeclarations schema uses upper-case type names; a lowercase "object"
#: is rejected by the endpoint.
PARAMETERS = {
    "type": "OBJECT",
    "properties": {
        "task": {
            "type": "STRING",
            "description": "What to do, self-contained: name files, commands, URLs and "
                           "the exact question the user asked, since Hermes does not see "
                           "this conversation.",
        },
        "context": {
            "type": "STRING",
            "description": "Optional background the worker needs: prior findings, tone, "
                           "constraints, what the user already tried.",
        },
    },
    "required": ["task"],
}


def declarations() -> list[dict]:
    """The functionDeclarations list for the setup frame.

    ``behavior: NON_BLOCKING`` goes on the declaration — not on the Tool entry, which the
    endpoint rejects ("Unknown name \"behavior\" at 'setup.tools[0]'"). Google's page for
    the extended-thinking Live model says function calling there is async-only; measured on
    this key it is also what makes it happen at all: 2/5 trials handed the work over with the
    flag, 0/5 without it. ``gemini-3.8-live`` calls either way (8/8), so the flag costs the
    non-thinking model nothing.
    """
    return [{**entry, "behavior": "NON_BLOCKING"} for entry in _DECLARATIONS]


_DECLARATIONS = [{"name": DELEGATE_NAME, "description": DESCRIPTION, "parameters": PARAMETERS}]


def compose_prompt(args: dict) -> str:
    """The run's prompt text: task, plus any context the model chose to pass."""
    task = str((args or {}).get("task") or "").strip()
    context = str((args or {}).get("context") or "").strip()
    if not task:
        return ""
    return f"{task}\n\nContext from the voice call: {context}" if context else task
