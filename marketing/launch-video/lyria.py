import json, os, sys, base64, urllib.request
TL = {s["id"]: s for s in json.load(open("timeline.json"))}
end = TL["end"]["b"]
prompt = (f"Instrumental track for a {round(end)} second high-energy tech product launch video. 128 BPM, driving, punchy and energizing from the very first second. "
 f"0 to {TL['mark']['a']:.0f}s: a tight pulsing synth bassline and filtered drums, already moving, building fast with a riser. "
 f"At {TL['mark']['a']:.0f}s a big hit and the full beat drops: hard four-on-the-floor kick, crisp claps, sidechained bass, bright synth stabs and a fast arpeggio. Relentless momentum, like a sprint. "
 f"At {TL['grow']['a']:.0f}s a short breakdown with a snare roll and a rising riser that accelerates, then a massive drop at {TL['grow']['b']:.0f}s, the most intense moment. "
 f"Keep the energy up to {TL['end']['a']:.0f}s, then end on a hard, clean final hit. "
 "Modern electronic, like a Nike or Apple ad: confident, fast, exciting. Leaves room for a voice-over in the mids. No vocals.")
print(prompt, file=sys.stderr)
body = {"model": "google/lyria-3-pro-preview", "modalities": ["text", "audio"], "audio": {"format": "mp3"}, "stream": True, "messages": [{"role": "user", "content": prompt}]}
for attempt in range(3):
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", json.dumps(body).encode(), {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json"})
    chunks = []
    for raw in urllib.request.urlopen(req, timeout=600):
        line = raw.decode().strip()
        if not line.startswith("data: ") or line == "data: [DONE]": continue
        for c in json.loads(line[6:]).get("choices", []):
            a = c.get("delta", {}).get("audio") or {}
            if a.get("data"): chunks.append(base64.b64decode(a["data"]))
    if chunks: open(os.environ.get("OUT", "lyria.mp3"), "wb").write(b"".join(chunks)); print("ok", sum(map(len, chunks))); break
    print("no audio, retry", file=sys.stderr)
