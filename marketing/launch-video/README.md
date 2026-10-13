# Type V launch video

The 68 s launch film (quote of Anthropic's source-control post): the hook, every landing feature, the
3D factory, the Kardashev zoom out to Type V, the waitlist. `scene.html` is the whole film as one page
whose `render(t)` draws any instant; the scripts turn it into an MP4.

Needs Node, ffmpeg, `uvx`, and `OPENROUTER_API_KEY` (from `status/.env.local`). `npm i` here first.

1. **Factory frames**: `mkdir f3 && node f3cap.mjs 120` captures the live landing's 3D factory (334 MB, not in git).
2. **Voice**: Jessica on ElevenLabs v3 through OpenRouter, the whole `script.json` in one take
   (`vo2/take.mp3`, committed). `uvx --with faster-whisper --with numpy python align.py vo2/take.mp3 script.json vo2/align.json`
   finds each line; `node cut.mjs` cuts one clip per line and writes `timeline.json`, which paces every scene.
3. **Music**: `python3 lyria.py` asks Lyria 3 for the track (`lyria-energy.mp3`, committed). `beats.py` finds
   its tempo and bars; `rebar.py` rebuilds it bar by bar so the drops land on the logo, Type V and the end:
   `uvx --with numpy python rebar.py lyria-energy.mp3 music3.wav 0.647 0,1,0,1,2,3,4,…,21,24,25,26,27,28,29,30,28,29,30,31`
4. **Mix**: `MUSIC=music3.wav node mix.mjs` (voice on top, the music ducking under it), then gain to −14 LUFS.
5. **Frames and MP4**: `mkdir frames && node render.mjs frames 30` (about 25 min), then
   `ffmpeg -framerate 30 -i frames/%04d.png -i mix2.wav -t 68.2 -c:v libx264 -pix_fmt yuv420p -crf 17 -c:a aac typeV-launch.mp4`.

`CHROME=<path>` points Playwright at a specific Chrome if its own isn't installed.
