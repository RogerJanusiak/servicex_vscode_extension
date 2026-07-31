"""Decode a ServiceX qastle `selection` string back into func_adl source.

Reads the qastle s-expression on stdin and writes Python source on stdout.
The extension runs this with whatever interpreter the user's Python
environment points at, because qastle has no JavaScript implementation -
anyone who submitted a func_adl query has it installed already (servicex
depends on func_adl, which depends on qastle).

Exit codes are how the extension decides whether to fall back to showing the
raw s-expression: 2 means "this interpreter can't do the job" (no qastle, or
a Python too old for ast.unparse), 3 means "the selection didn't parse".

Options:
  --nested    keep stream operators in qastle's prefix form
  --metadata  keep the MetaData(...) wrappers func_adl's type system injects
"""

import ast
import sys

EXIT_UNAVAILABLE = 2
EXIT_BAD_SELECTION = 3

INDENT = "    "
WIDTH = 100

# qastle.linq_util.linq_operator_names - every call qastle recognizes as a
# stream operator, and therefore every call that was originally written as a
# `.Method(...)` on the stream. All of them take the stream as their first
# positional argument.
LINQ_OPERATORS = frozenset(
    [
        "Where",
        "Select",
        "SelectMany",
        "First",
        "Last",
        "ElementAt",
        "Contains",
        "Aggregate",
        "Count",
        "Max",
        "Min",
        "Sum",
        "All",
        "Any",
        "Concat",
        "Zip",
        "OrderBy",
        "OrderByDescending",
        "Choose",
    ]
)


class _StripMetaData(ast.NodeTransformer):
    """Drop the `MetaData(stream, {...})` wrappers around the real query.

    A backend-specific func_adl package (func_adl_servicex_xaodr25 and
    friends) attaches one of these every time the query touches a collection
    or calls a C++ method: include files, link libraries, injected code. None
    of it was written by hand - a query with a couple of dozen `.pt()` calls
    can end up under seventy nested wrappers, which buries the two Selects
    the user actually wrote. `MetaData(stream, ...)` evaluates to `stream`,
    so unwrapping is the whole job.
    """

    def __init__(self):
        self.removed = 0

    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "MetaData" and node.args:
            self.removed += 1
            return node.args[0]
        return node


class _Rechain(ast.NodeTransformer):
    """Rewrite `Select(stream, f)` back into `stream.Select(f)`.

    qastle stores stream operators in prefix form, so a straight unparse
    yields deeply nested `Select(Where(EventDataset(), ...), ...)`. Users
    wrote the chained form, so putting it back makes the recovered query
    look like the source they submitted.
    """

    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id in LINQ_OPERATORS and node.args:
            source, *rest = node.args
            return ast.Call(
                func=ast.Attribute(value=source, attr=node.func.id, ctx=ast.Load()),
                args=rest,
                keywords=node.keywords,
            )
        return node


def _lambda_header(node):
    return f"lambda {', '.join(a.arg for a in node.args.args)}: "


def _split_chain(node):
    """A `a.X(...).Y(...)` chain as (base, [calls in written order])."""
    calls = []
    current = node
    while isinstance(current, ast.Call) and isinstance(current.func, ast.Attribute):
        calls.append(current)
        current = current.func.value
    calls.reverse()
    return current, calls


def _unwrap(tree):
    """The query expression itself - qastle hands back a Module wrapping it."""
    node = tree
    while True:
        if isinstance(node, ast.Module) and len(node.body) == 1:
            node = node.body[0]
        elif isinstance(node, (ast.Expression, ast.Expr)):
            node = node.body if isinstance(node, ast.Expression) else node.value
        else:
            return node


def _format(node, indent):
    """Render `node`, breaking it across lines only when it doesn't fit."""
    flat = ast.unparse(node)
    if len(indent) + len(flat) <= WIDTH:
        return flat

    if isinstance(node, ast.Dict):
        inner = indent + INDENT
        entries = []
        for key, value in zip(node.keys, node.values):
            if key is None:  # {**spread}
                entries.append(f"{inner}**{_format(value, inner)}")
            else:
                entries.append(f"{inner}{ast.unparse(key)}: {_format(value, inner)}")
        return "{\n" + ",\n".join(entries) + f"\n{indent}}}"

    if isinstance(node, ast.Lambda):
        # The body carries on at the same indent, so a dict body closes its
        # brace under the line the lambda started on.
        return _lambda_header(node) + _format(node.body, indent)

    if isinstance(node, ast.Call):
        base, calls = _split_chain(node)
        inner = indent + INDENT
        if len(calls) > 1:
            # One `.Select(...)` per line, wrapped in parens so the chain
            # stays a single expression.
            lines = [f"{inner}{_format(base, inner)}"]
            for call in calls:
                args = ", ".join(_format(a, inner) for a in call.args)
                lines.append(f"{inner}.{call.func.attr}({args})")
            return "(\n" + "\n".join(lines) + f"\n{indent})"
        args = [f"{inner}{_format(a, inner)}" for a in node.args]
        if args:
            return f"{ast.unparse(node.func)}(\n" + ",\n".join(args) + f"\n{indent})"

    return flat


def format_source(tree):
    """Lay the query out over several lines - with black when it's installed.

    black is the better formatter by a wide margin, but it isn't part of the
    servicex dependency chain, so most analysis environments won't have it.
    The fallback handles the two things that actually make a func_adl query
    unreadable on one line: the operator chain and the big projection dicts.
    """
    flat = ast.unparse(tree)
    try:
        import black

        return black.format_str(flat, mode=black.Mode(line_length=WIDTH)).strip()
    except Exception:
        pass

    formatted = _format(_unwrap(tree), "")
    try:
        ast.parse(formatted)
    except SyntaxError:
        # Never hand back something that won't parse - a query that reads
        # badly beats one that can't be copied back into a notebook.
        return flat
    return formatted


def qastle_to_source(selection, chained=True, keep_metadata=False):
    import qastle

    tree = qastle.text_ast_to_python_ast(selection)

    removed = 0
    if not keep_metadata:
        stripper = _StripMetaData()
        tree = stripper.visit(tree)
        removed = stripper.removed
    if chained:
        tree = _Rechain().visit(tree)
    tree = ast.fix_missing_locations(tree)

    note = ""
    if removed:
        note = (
            f"# {removed} MetaData(...) wrapper{'s' if removed != 1 else ''} generated by func_adl's\n"
            "# type system (include files, link libraries, injected C++) removed for\n"
            "# readability - turn on servicex.showQueryMetadata to keep them.\n\n"
        )
    return note + format_source(tree)


def main(argv):
    chained = "--nested" not in argv
    keep_metadata = "--metadata" in argv
    selection = sys.stdin.read().strip()

    # ast.unparse landed in 3.9; without it there's nothing to fall back on
    # inside this script, so let the extension print the raw s-expression.
    if not hasattr(ast, "unparse"):
        print("Python 3.9 or newer is required to unparse a query", file=sys.stderr)
        return EXIT_UNAVAILABLE
    try:
        import qastle  # noqa: F401
    except ImportError:
        print("qastle is not installed in this interpreter", file=sys.stderr)
        return EXIT_UNAVAILABLE

    try:
        sys.stdout.write(qastle_to_source(selection, chained=chained, keep_metadata=keep_metadata))
    except Exception as e:  # noqa: BLE001 - any parse failure is a fallback
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        return EXIT_BAD_SELECTION
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
