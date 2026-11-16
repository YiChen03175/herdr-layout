"""Puts the look picked in Customize (data/my-setup/style.json) on a layout, or takes it off.

  style.py apply <layout.json> <style.json> <out.json>   install.sh: the repo's layout, styled
  style.py undo  <layout.json> <style.json> <out.json>   export.sh: this machine's, unstyled

style.json: {"root": {...}, "nodes": {id: {...}}, "undo": {"root": ..., "nodes": ...}}.
A null value removes the key; "colors" merges by name. Missing or unreadable: no change.
"""
import json
import sys


def patch(node, changes):
    for key, value in changes.items():
        if key == "colors" and isinstance(value, dict):
            colors = {**node.get("colors", {}), **value}
            colors = {k: v for k, v in colors.items() if v is not None}
            if colors:
                node["colors"] = colors
            else:
                node.pop("colors", None)
        elif value is None:
            node.pop(key, None)
        else:
            node[key] = value


def put(layout, style):
    patch(layout, style.get("root", {}))
    nodes = style.get("nodes", {})

    def walk(n):
        patch(n, nodes.get(n.get("id"), {}))
        for c in n.get("children") or []:
            walk(c)
    walk(layout)


def main():
    how, src, style_path, out = sys.argv[1:]
    layout = json.load(open(src))
    try:
        style = json.load(open(style_path))
    except (OSError, ValueError):
        style = {}
    put(layout, style if how == "apply" else style.get("undo", {}))
    with open(out, "w") as f:
        json.dump(layout, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
