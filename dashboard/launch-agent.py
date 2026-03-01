#!/usr/bin/env python3
"""Launch claude -p with prompt from file.

Usage: launch-agent.py <prompt-file>

Reads the prompt from the given file and execs claude directly.
The parent PTY (node-pty) captures all output for the dashboard.
"""
import os, sys

if len(sys.argv) != 2:
    print("Usage: launch-agent.py <prompt-file>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1]) as f:
    prompt = f.read()

# Replace this process with claude — PTY captures output directly.
# stream-json sends one JSON object per line; the orchestrator's onData
# parses these and extracts human-readable text for the dashboard logs.
os.execvp('claude', [
    'claude', '-p', '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    prompt
])
