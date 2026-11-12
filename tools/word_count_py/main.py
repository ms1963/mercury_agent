#!/usr/bin/env python3
"""Example Mercury polyglot tool: JSON args on stdin, JSON result on stdout."""
import json, sys

args = json.load(sys.stdin)
text = str(args.get("text", ""))
result = {"words": len(text.split()), "lines": len(text.splitlines()) or (1 if text else 0), "characters": len(text)}
print(json.dumps({"content": f"{result['words']} words, {result['lines']} lines, {result['characters']} characters", "data": result}))
