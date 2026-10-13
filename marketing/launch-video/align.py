# word timestamps for the take, mapped onto the script's lines by fuzzy word alignment
import json, re, sys, difflib
from faster_whisper import WhisperModel
take, script = sys.argv[1], json.load(open(sys.argv[2]))
import subprocess, numpy as np
pcm = np.frombuffer(subprocess.run(["ffmpeg", "-loglevel", "error", "-i", take, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True).stdout, np.float32)
segs, _ = WhisperModel("small.en", compute_type="int8").transcribe(pcm, language="en", word_timestamps=True)
W = [(w.word, w.start, w.end) for s in segs for w in s.words]
norm = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())
heard = [norm(w) for w, _, _ in W]
ref, owner = [], []
for k, l in enumerate(script):
    for w in l["text"].replace("-", " ").split(): ref.append(norm(w)); owner.append(k)
m = difflib.SequenceMatcher(None, ref, heard, autojunk=False)
span = {}
for a, b, n in m.get_matching_blocks():
    for i in range(n):
        k = owner[a + i]; _, s, e = W[b + i]; lo, hi = span.get(k, (s, e)); span[k] = (min(lo, s), max(hi, e))
out = [{"id": l["id"], "start": round(span[k][0], 2), "end": round(span[k][1], 2)} for k, l in enumerate(script) if k in span]
json.dump(out, open(sys.argv[3], "w"), indent=1); print("\n".join(f'{o["id"]:8} {o["start"]:6} {o["end"]:6}' for o in out)); print("missing:", [l["id"] for k, l in enumerate(script) if k not in span])
