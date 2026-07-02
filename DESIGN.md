# TeleSculpt — 3D Voxel Telephone

A mobile party game: **Doodle Telephone, but the drawings are 3D voxel sculptures.**

One player writes a phrase. The next player sculpts it in 3D clay on their phone. The
next player guesses what the sculpture is. The next sculpts *that* guess. By the end,
"a cat playing bagpipes" has become "angry submarine." The reveal — a rotating 3D
turntable gallery of each chain — is the whole point.

Built on the Challenge #3 stack (see `mobile-game-challenge-brief.md`): Azure Functions
v4 (Node), Table Storage for state, Blob Storage for sculpture files, GitHub Pages
frontend, GUID identity, GitHub Actions spin-up/spin-down, Playwright CLI testing.
The only twist: the frontend is a full Three.js 3D experience.

---

## Game Rules

- **3–8 players** (2 allowed for testing). One host creates a room, gets a 4-letter
  room code, others join via link/code.
- Every player starts one **chain**. With N players there are N chains, each N steps long.
- **Step 0**: every player writes a starting phrase (their chain's prompt).
- **Odd steps (1, 3, 5…)**: you receive a phrase → you **sculpt** it in voxels.
- **Even steps (2, 4, 6…)**: you receive a sculpture → you **guess** what it is (free text).
- Chain rotation: chain `i` at step `k` is handled by player `(i + k) mod N`.
  Every chain visits every player exactly once. Game has exactly N steps (0..N-1).
- A step advances only when **all** players have submitted for that step.
- After the last step: **reveal** phase — walk each chain step by step with 3D turntable
  viewers for sculptures.
- Soft client-side timers for pacing (45s write/guess, 120s sculpt). On expiry the
  client auto-submits whatever exists (placeholder text `"…mysterious silence…"` if empty).
  The server never enforces timers.

## Phases (room state machine)

```
lobby → playing (step 0..N-1) → reveal
```

---

## Storage model

### Table Storage — table `rooms`
One entity per room. PartitionKey = `"room"`, RowKey = room code (e.g. `KJXQ`).

| Field | Type | Notes |
|---|---|---|
| phase | string | `lobby` \| `playing` \| `reveal` |
| step | number | current step index, 0-based |
| hostId | string | GUID of host |
| playersJson | string | JSON array `[{ id, name, color }]` — order fixed at start |
| createdAt | string | ISO |

Advancement uses ETag optimistic concurrency with retry: on submit, count turns for
current step; if count == N, bump `step` (or set `phase=reveal` when `step == N-1`).
Both racers compute the same result, so a lost race retry is idempotent.

### Table Storage — table `turns`
One entity per submission. PartitionKey = room code, RowKey = `${chainIndex}-${stepIndex}`
(zero-padded 2 digits each, e.g. `03-02`).

| Field | Type | Notes |
|---|---|---|
| playerId | string | who submitted |
| type | string | `text` \| `sculpture` |
| text | string? | for write/guess steps |
| blobUrl | string? | for sculpt steps |
| submittedAt | string | ISO |

### Blob Storage — container `sculptures`
- Blob path: `{roomCode}/{chainIndex}-{stepIndex}.json`
- Content: sculpture JSON (below). Container has **public blob read**.
- Upload uses the **SAS pattern**: Function returns a write-only SAS URL, the client
  PUTs the JSON directly to Blob. No binary through the Function.

### Sculpture JSON format
```json
{
  "v": 1,
  "size": 16,
  "palette": ["#e63946", "#f4a261", "#e9c46a", "#2a9d8f", "#264653", "#a8dadc", "#ffffff", "#6d597a"],
  "voxels": [[x, y, z, paletteIndex], ...]
}
```
Grid is 16×16×16, coordinates 0–15 integers. `voxels` is a flat array of 4-tuples.

---

## API Contract (FROZEN — both sides build against this)

Base path `/api`. All bodies JSON. All responses JSON. CORS: allow all origins.
Errors: non-2xx with `{ "error": "human readable message" }`.

### `POST /api/rooms`
Create a room. Body: `{ "name": "Sunny" }`
→ `201 { "roomCode": "KJXQ", "playerId": "<guid>" }`

### `POST /api/rooms/{code}/join`
Body: `{ "name": "Alex" }`
→ `200 { "playerId": "<guid>", "roomCode": "KJXQ" }`
Errors: 404 room not found, 409 game already started or room full (8).

### `POST /api/rooms/{code}/start`
Body: `{ "playerId": "<hostGuid>" }` — host only, needs ≥2 players.
→ `200 { "ok": true }`  (sets phase=playing, step=0, freezes player order)
Errors: 403 not host, 409 not enough players / already started.

### `GET /api/rooms/{code}/state?playerId=<guid>`
The polling endpoint (clients poll every 2s).
→ `200`:
```json
{
  "phase": "playing",
  "step": 2,
  "totalSteps": 4,
  "players": [{ "id": "...", "name": "Sunny", "color": "#e63946", "done": true }],
  "hostId": "<guid>",
  "youSubmitted": false
}
```
`done` = that player submitted for the current step (only meaningful in `playing`).
In `lobby`, `step` is 0 and `done` is false. `totalSteps` = playerCount (0 in lobby).

### `GET /api/rooms/{code}/task?playerId=<guid>`
What should this player do right now (phase=playing only)?
→ `200`:
```json
{ "type": "write" }
{ "type": "sculpt", "chainIndex": 2, "prompt": "a cat playing bagpipes" }
{ "type": "guess",  "chainIndex": 2, "sculptureUrl": "https://...blob.../02-01.json" }
```
Errors: 409 if not in playing phase.

### `POST /api/rooms/{code}/upload-url`
Body: `{ "playerId": "<guid>" }` — returns SAS for this player's current sculpt target.
→ `200 { "sasUrl": "https://...sig=...", "blobUrl": "https://.../sculptures/KJXQ/02-01.json" }`
Client does `PUT sasUrl` with headers `x-ms-blob-type: BlockBlob`, `Content-Type: application/json`.

### `POST /api/rooms/{code}/submit`
Body: `{ "playerId": "<guid>", "text": "..." }` or `{ "playerId": "<guid>", "blobUrl": "..." }`
→ `200 { "ok": true, "advanced": true|false }`
Idempotent: resubmission for an already-submitted step returns `{ ok: true, advanced: false }`.

### `GET /api/rooms/{code}/reveal`
Phase must be `reveal`.
→ `200`:
```json
{
  "chains": [
    { "steps": [
      { "type": "text", "playerName": "Sunny", "playerColor": "#e63946", "text": "a cat playing bagpipes" },
      { "type": "sculpture", "playerName": "Alex", "playerColor": "#2a9d8f", "blobUrl": "https://..." },
      { "type": "text", "playerName": "Kim", "playerColor": "#f4a261", "text": "submarine" }
    ]}
  ]
}
```

### `GET /api/health`
→ `200 { "ok": true }`

---

## Repo layout

```
/docs                 frontend (GitHub Pages root)
  index.html          single-page app
  css/style.css
  js/config.js        API base URL (localhost auto-detect)
  js/api.js           fetch wrappers for the contract above
  js/app.js           screen router + polling + game flow
  js/sculptor.js      Three.js touch voxel editor
  js/viewer.js        Three.js sculpture viewer (turntable)
  js/reveal.js        reveal gallery flow
/api                  Azure Functions v4, Node 22, JavaScript
  package.json
  host.json
  local.settings.json (gitignored; sample provided)
  src/functions/*.js
  src/lib/*.js        storage helpers + pure game logic
  test/               node:test unit tests for game logic
/infra
  provision.ps1 / provision.sh   az CLI provisioning (idempotent)
/.github/workflows
  spin-up.yml         provision + deploy backend (workflow_dispatch)
  spin-down.yml       delete resource group (typed confirmation)
  pages.yml           deploy /docs to GitHub Pages
/tests                Playwright CLI scripts (named sessions host/p2/p3)
DESIGN.md             this file
```

## Azure naming (single environment)

- Resource group: `rg-telesculpt`
- Storage account: `sttelesculpt<suffix>` (suffix for global uniqueness, stored in repo variable)
- Function app: `func-telesculpt-<suffix>` (consumption, Node 22)
- Region: `westus2`

## Local dev

- `npm run azurite` (or docker) — local storage emulator, with blob CORS configured
  by `/api/scripts/setup-local.js` (creates tables, container, sets CORS on blob service).
- `cd api && func start` → http://localhost:7071
- Serve `/docs` with any static server on :8080. `js/config.js` auto-detects
  localhost and targets http://localhost:7071/api.

## Frontend visual direction

Dark theme, deep indigo→plum gradient background, clay-like matte voxels with soft
studio lighting (hemisphere + directional with shadows), rounded 2xl cards, big
touch targets (min 48px), spring transitions between screens, subtle confetti at
reveal moments. Font: system stack with a display font (e.g. "Fredoka"/Google Fonts
is NOT allowed offline — use system-ui with weight/size hierarchy instead; a bundled
woff2 is fine if committed). Must look professionally designed, not like a demo.
