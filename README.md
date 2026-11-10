# Proofmark

Grade a class set of handwritten math assessments with Claude. Scan or photograph student work and Proofmark:

- reads the handwriting, grades each question with partial credit, and pinpoints the step where the reasoning went wrong (including proof logic)
- builds the answer key itself from the printed questions, so no key upload is needed
- tags every question with its Common Core (CCSS) standard and shows class mastery by standard and by concept
- writes feedback for each student (what went well, next focus, next steps, a hint)
- builds a reteach plan with an activity for every gap and small groups by misconception
- generates practice worksheets, assessments and rubrics, optionally aimed at the class's gaps
- exports a gradebook CSV and printable feedback pages

## Privacy

Page images and grades never get stored on the server. The server only relays each grading request to the Anthropic API and returns the result. Assessments, grades and feedback are saved in the teacher's own browser (localStorage). Clearing browser data deletes them, so export the CSV to keep a copy.

## Run it

Requires Node 20+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY and ACCESS_CODE
npm run dev
```

Open http://localhost:3000 and enter your access code.

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Key used for every grading request. Usage is billed to this key. |
| `ACCESS_CODE` | strongly recommended | Shared code teachers enter to open the app. Without it, anyone with the link can use your key. |
| `SESSION_SECRET` | no | Signs the login cookie. Defaults to a value derived from `ACCESS_CODE`. |
| `CLAUDE_MODEL` | no | Defaults to `claude-opus-5-5`. |

## Deploy on Railway

1. Create a Railway project from this repo (or run `railway up` in this folder).
2. Set `ANTHROPIC_API_KEY` and `ACCESS_CODE` in the service's Variables.
3. Generate a domain under Settings → Networking.

## How it's built

`src/proofmark.html` is the app. It runs as-is as a claude.ai artifact, where it uses the viewer's own Claude account. For self-hosting, `npm run build` wraps it into `public/index.html` with `public/shim.js`, which provides the same calls through this server (`server.js`) and the browser's local storage.

Grading uses Claude Opus 5.5 with server-side refusal fallbacks enabled (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

## License

MIT
