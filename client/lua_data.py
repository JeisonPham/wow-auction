"""A reader for the literal subset written by WoW SavedVariables. Never executes Lua."""

import re

TOKEN = re.compile(
    r"""(?:\s+|--[^\n]*(?:\n|$))*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|-?(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?|[{}=,;\[\]])""",
    re.DOTALL,
)


class Reader:
    def __init__(self, text, pos=0):
        self.text = text
        self.pos = pos
        self.next()

    def next(self):
        match = TOKEN.match(self.text, self.pos)
        self.token = match[1] if match else None
        if match:
            self.pos = match.end()

    def take(self, token):
        if self.token != token:
            raise ValueError(f"Expected {token!r} near offset {self.pos}")
        self.next()

    def value(self, depth=0):
        token = self.token
        if token is None or depth > 100:
            raise ValueError("Incomplete or deeply nested Lua data")
        if token == "{":
            self.next()
            table, index = {}, 1
            while self.token != "}":
                if self.token == "[":
                    self.next()
                    key = self.value(depth + 1)
                    self.take("]")
                    self.take("=")
                    value = self.value(depth + 1)
                elif (
                    self.token
                    and re.fullmatch(r"[A-Za-z_]\w*", self.token)
                    and self.token not in ("true", "false", "nil")
                ):
                    key = self.token
                    self.next()
                    self.take("=")
                    value = self.value(depth + 1)
                else:
                    key, index = index, index + 1
                    value = self.value(depth + 1)
                if key in table:
                    raise ValueError("Duplicate Lua table key")
                table[key] = value
                if self.token in (",", ";"):
                    self.next()
                elif self.token != "}":
                    raise ValueError("Expected table separator")
            self.next()
            return table
        self.next()
        if token[0] in ("'", '"'):
            escapes = {
                "n": "\n",
                "r": "\r",
                "t": "\t",
                "a": "\a",
                "b": "\b",
                "f": "\f",
                "v": "\v",
            }
            return re.sub(
                r"\\(\d{1,3}|.)",
                lambda m: chr(int(m[1])) if m[1].isdigit() else escapes.get(m[1], m[1]),
                token[1:-1],
                flags=re.DOTALL,
            )
        if token in ("true", "false", "nil"):
            return {"true": True, "false": False, "nil": None}[token]
        try:
            return float(token) if "." in token or "e" in token.lower() else int(token)
        except ValueError:
            raise ValueError(f"Unsupported Lua literal {token!r}") from None


def named_table(text, name):
    match = re.search(r"(?m)^\s*" + re.escape(name) + r"\s*=\s*(?=\{)", text)
    if match:
        return Reader(text, match.end()).value()
    return None


def array(table):
    if isinstance(table, list):
        return table
    if set(table) != set(range(1, len(table) + 1)):
        raise ValueError("Expected a contiguous Lua array")
    return [table[n] for n in range(1, len(table) + 1)]
