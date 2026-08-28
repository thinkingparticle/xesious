#!/usr/bin/env python3
"""A stand-in for voice/speak.py in tier 2.

Real synthesis runs at roughly realtime, so a test that used it would take minutes.
This speaks the same protocol — a chunk line per note, then `full`, then `done` with
the per-unit timings — using near-silent Opus made by ffmpeg, so the bridge's whole
progressive path runs: the notes, the stop button, the section index on the full
file, the tidy button and the read-along page.

XESIOUS_SPEAK_STUB_SLOW: a file whose existence makes each chunk take ~3s, so a test
can cancel one mid-flight. Not named TG_* because childEnv() strips that prefix
before spawning, and the marker would never arrive.
"""
import json
import os
import subprocess
import sys
import time


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def main() -> int:
    req = json.loads(sys.stdin.read())
    units = req.get("units") or []
    single = req.get("out")
    outdir = req.get("outdir") or (os.path.dirname(single) if single else ".")
    if not units:
        return 2
    ff = os.environ.get("TG_FFMPEG") or "ffmpeg"
    slow = os.environ.get("XESIOUS_SPEAK_STUB_SLOW")

    def make(path, seconds=0.4):
        subprocess.run([ff, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                        "-t", str(seconds), "-c:a", "libopus", "-b:a", "32k", path],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    # One second of "audio" per unit, so the timings are predictable to assert on.
    timings, t = [], 0.0
    for _ in units:
        timings.append([round(t, 3), round(t + 1.0, 3)])
        t += 1.0 + 0.4

    if single:
        make(single)
        emit({"done": True, "seconds": round(t, 3), "chunks": 1, "timings": timings})
        return 0

    # Two chunks for a substantial answer, one for a short one — the real splitter
    # closes a chunk on accumulated SECONDS, and both outcomes have their own paths:
    # multiple notes get a full file, an index on it and a tidy button, while a single
    # note gets the index on itself and no duplicate audio file.
    n = 2 if len(units) >= 4 else 1
    at = 0.0
    for i in range(1, n + 1):
        if slow and os.path.isfile(slow):
            time.sleep(3)
        p = os.path.join(outdir, f"part-{i}.ogg")
        make(p)
        emit({"chunk": i, "path": p, "seconds": round(t / n, 1), "at": round(at, 1)})
        at += t / n
    if n > 1:
        full = os.path.join(outdir, "full.ogg")
        make(full, 0.8)
        emit({"full": full, "seconds": round(t, 1), "chunks": n, "timings": timings})
    emit({"done": True, "seconds": round(t, 3), "chunks": n, "timings": timings})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
