"""Workflow helpers for agents: import and call from ONE python script.

    import sys; sys.path.insert(0, "<agent-lib>/python"); import wf
    print(wf.ctx("a.py", "b.toml"))   # files with line numbers
    print(wf.git_snap())              # branch, ahead/behind, status, recent commits
    print(wf.log_triage("logs/", grep="ERROR", fields="type"))
Each returns the tool's text output (stdout+stderr) as a str.
"""
import os
import subprocess

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin")


def _run(tool, *args):
    p = subprocess.run([os.path.join(_DIR, tool), *map(str, args)], capture_output=True, text=True)
    return p.stdout + p.stderr


def ctx(*files):
    return _run("ctx", *files)


def git_snap():
    return _run("git-snap")


def log_triage(target, grep=None, fields=None):
    args = [target]
    if grep:
        args += ["--grep", grep]
    if fields:
        args += ["--fields", fields]
    return _run("log-triage", *args)
