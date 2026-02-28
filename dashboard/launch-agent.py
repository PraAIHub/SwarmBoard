#!/usr/bin/env python3
"""Launch claude -p with a prompt read from a file.

Usage: launch-agent.py <prompt-file>

Reads the prompt from the given file and exec's claude -p with it.
This avoids shell expansion issues with backticks and $ in prompts.
Uses os.execvp so the process replaces this script (keeps PID, PTY).
"""
import os, sys

if len(sys.argv) != 2:
    print("Usage: launch-agent.py <prompt-file>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1]) as f:
    prompt = f.read()

os.execvp('claude', ['claude', '-p', prompt])
