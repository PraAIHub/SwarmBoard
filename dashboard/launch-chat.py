#!/usr/bin/env python3
"""Launch claude -p for PM chat with prompt from file.

Usage: launch-chat.py <prompt-file>

Reads the prompt from the given file and execs claude directly.
Uses --max-turns 1 since each chat round is a single response.
"""
import os, sys

if len(sys.argv) != 2:
    print("Usage: launch-chat.py <prompt-file>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1]) as f:
    prompt = f.read()

os.execvp('claude', [
    'claude', '-p',
    '--output-format', 'text',
    prompt
])
