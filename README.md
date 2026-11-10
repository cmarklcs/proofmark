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

## Toddle gradebook (LTI 1.3)

Proofmark can run as an LTI 1.3 tool inside Toddle. Teachers open it from an assignment, skip the access code, match the names Claude read on each paper to the Toddle class list, and send scores (optionally with each student's feedback as a comment) into the Toddle gradebook.

Server variables (from Toddle's **Toddle LTI Credentials** panel):

| Variable | Toddle field |
|---|---|
| `LTI_ISSUER` | Issuer URL |
| `LTI_CLIENT_ID` | Client ID |
| `LTI_DEPLOYMENT_ID` | Deployment ID |
| `LTI_AUTH_URL` | Login URL |
| `LTI_JWKS_URL` | Keyset URL |
| `LTI_TOKEN_URL` | Token URL |
| `PUBLIC_URL` | This app's public address, e.g. `https://proofmark.example.app` |
| `LTI_PRIVATE_KEY_B64` | Proofmark's own RSA signing key, base64 PKCS#8 PEM: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| base64` |

What to enter in Toddle's custom LTI app form (replace the host with your `PUBLIC_URL`):

| Toddle field | Value |
|---|---|
| Initiate login URL | `PUBLIC_URL/lti/login` |
| Launch/Redirect URL(s) | `PUBLIC_URL/lti/launch` |
| Keyset URL | `PUBLIC_URL/.well-known/jwks.json` |
| Target link URI | `PUBLIC_URL/lti/launch` |
| Placement | Assignment |
| Allow grade passback | On |
| Allow roster access | On (needed to match names) |
| Message type | Deep linking |
| Privacy level | Public (names are needed to match papers to students) |

`GET /lti/config` on the running server lists these URLs.

## How it's built

`src/proofmark.html` is the app. It runs as-is as a claude.ai artifact, where it uses the viewer's own Claude account. For self-hosting, `npm run build` wraps it into `public/index.html` with `public/shim.js`, which provides the same calls through this server (`server.js`) and the browser's local storage.

Grading uses Claude Opus 5.5 with server-side refusal fallbacks enabled (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

## License

MIT
