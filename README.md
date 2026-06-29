# Game Hub 🎲🃏⚽

A multiplayer party-game hub you play from your phone browser — no app install.
One person creates a room, everyone opens the link, and the host picks any of **ten**
games. The server is the authoritative referee: it owns every secret (decks, hidden
cards, secret players) so no client can ever peek.

TypeScript end to end — a Node + `ws` server and a vanilla HTML/CSS/JS client served
as static files. **No build step:** Node runs the `.ts` files directly via native type
stripping.

---

## The games

| Game | Players | What it is |
| --- | --- | --- |
| **Win or Die** | 2–8 | Poker-style betting & bluffing with rock-paper-scissors hands. Last player standing. |
| **Lock In** | 2–8 | Press-your-luck with 9 dice — lock a number, set one aside per roll, bank before you bust. |
| **Yahtzee** | 1–8 | Roll five dice up to three times, fill all 13 categories. Highest total wins. |
| **Spy Game** | 3–8 | Hidden-role football clues: everyone shares a secret player — except the spy (two spies at 6+). |
| **Codenames** | 4–8 | Two teams, one secret key. Spymasters clue; operatives find their agents, dodge the assassin. |
| **Quoridor** | 2–4 | Race your pawn to the far side, or wall off your rivals. Pure strategy. |
| **Tectonic Shift** | 2–4 | Slide pawns across a shrinking hex board, banking the land you leave behind. |
| **Memory Match** | 2–4 | Concentration with a word↔picture twist, each player in their own language (en/fr/ko). |
| **Who Am I?** | 2–6 | Football 20-questions — the server answers yes/no from real data; race to name the player. |
| **Guess the Player** | 1–6 | Wordle for footballers: guess real players, get attribute hints (value ↑/↓, position, nationality…). |

Five of these are powered by a shared **football player bank** (Spy Game, Who Am I?,
Guess the Player, and the decoy engine) — see [The player bank](#the-player-bank).

---

## Architecture

The hub is a **game-agnostic room** plus a set of **game plugins**. The room
(`src/platform/room.ts`) owns everything that isn't a game's rules — the lobby, seats,
host, chat, game selection, host options, reconnection, bots, leave/kick, "play again."
It knows nothing game-specific.

Each game is a plugin implementing the **`GameDef`** contract (`src/platform/types.ts`):

```ts
interface GameDef<S> {
  id; name; blurb; minPlayers; maxPlayers; options?;
  create(setup, ctx): S;                       // start a match → opaque state
  act(state, seat, msg, ctx): { error? } | void; // apply an action (untrusted input)
  tick?(state, ctx): boolean;                  // timers / clocks (~2 Hz)
  view(state, seat): {...};                    // PRIVATE per-seat snapshot (redacted)
  result(state): { over, winners };
  bot?(state, seat, ctx): msg | null;          // play a seat taken over by AI
}
```

Games register in `src/platform/registry.ts`; the server (`src/server.ts`) is a thin
transport that validates WebSocket messages, routes them to the room, and broadcasts
each seat's private `view` after every change.

### Why it's safe (and testable)

- **Authoritative server.** All randomness and all secrets live server-side. `view` is
  per-seat and redacted — a player never receives another's hidden cards, the spy's
  decoy, or the secret target until it's legitimately revealed.
- **Pure game state.** Each plugin's `state` is plain JSON with the RNG injected via
  `ctx`, so every game is unit-tested deterministically (`node --test`, 177 tests).
- **Bots & resilience.** Any seat can be driven by the game's `bot` — used when a player
  leaves or is kicked, so turn-based games never stall. Reconnection: each player gets a
  `localStorage` token and resumes their exact seat after a drop.

### Hub features (every game gets these for free)

- **Lobby & host** — the host picks the game and tunes **options** (e.g. turn timer,
  rounds, guess limit, Memory Match pairs).
- **Turn timer** — opt-in per-turn countdown (Spy / Quoridor / Codenames / Who Am I? /
  Guess the Player); on timeout the game's bot acts so play continues.
- **Leave → lobby, kick, play again** — a player can step back to the room lobby (a bot
  finishes their seat); the host can remove anyone (incl. bots), mid-match too; and after
  a match the host can **Play again** (same game) or send everyone **back to the lobby**.

---

## The player bank

The football games share one dataset, `players.json` — ~710 players, each:

```json
{ "name", "nationality", "positions": ["ST"], "leagues": ["Premier League"],
  "marketValue": 180000000, "status": "active", "eraOfPlay": "2020s", "imageUrl": "…" }
```

- **Built from Transfermarkt dumps** by `build-wordbank.cjs`: it shapes the raw scraper
  output (`raw-players.json` + `legends-raw.json`, kept out of git), maps positions to
  fine codes, caps actives at a **€20m market-value** floor, keeps a curated set of
  legends, and validates that every player has a same-position peer. The raw dumps are
  `.gitignore`d; the committed `players.json` is what the app actually loads.
- **`decoy.cjs`** is the single source of truth for similarity: `pickDecoy(target, pool)`
  picks the most-alike player (position filter, then nationality/league/era/value-tier
  scoring). Spy Game and Guess the Player both consume it so feedback and decoys stay
  consistent.
- **Player cards.** Reveals render a FUT/Panini-style card — position, nationality flag,
  league, value tier (Bronze→Gold→ICON), and the player's **portrait photo**
  (`imageUrl`, hotlinked from Transfermarkt; cards fall back to a clean gradient+text
  card if an image is missing or fails to load).

> Note: portraits are hotlinked from Transfermarkt's CDN — fine for a personal project,
> but it's a third-party dependency (and their imagery). To self-host or drop photos,
> change `imageUrl` handling in `build-wordbank.cjs`.

---

## Visual system

Vanilla CSS, no framework. A token layer (`:root` in `src/client/style.css`) defines
spacing/radius/elevation scales, semantic colors, and a **per-game accent**. Polish
includes the player card, Wordle-style tile-flip reveals, win confetti, screen
transitions, backdrop-blurred sheets, and inline SVG icons — all gated behind
`prefers-reduced-motion`.

---

## Project layout

```text
src/
  platform/
    types.ts        The GameDef contract + lobby summaries.
    room.ts         Game-agnostic room: lobby, host, options, bots, leave/kick, restart.
    registry.ts     The list of hostable games.
    turn-timer.ts   Shared opt-in per-turn countdown helper.
    room.test.ts
  games/
    win-or-die/  lock-in/  yahtzee/  spy-game/  codenames/
    quoridor/  tectonic/  memory-match/  who-am-i/  guess-player/
        game.ts        Pure plugin (rules + per-seat view). game.test.ts alongside.
        wordbank.ts / conceptbank.ts   Loads injected data for data-driven games.
  server.ts         Thin transport: static files, WebSocket plumbing, broadcast, tick.
  client/
    index.html      Mobile-first single page (one screen per game).
    style.css       The visual system.
    app.js          Thin renderer — shows only the server's private view.
build-wordbank.cjs  Builds players.json from the Transfermarkt dumps.
decoy.cjs           Shared player-similarity / decoy selection (+ its own tests).
players.json        The committed football player bank.
```

---

## Run locally

Requires **Node 24+** (native TypeScript execution — no build step).

```bash
npm install
npm test          # all game-engine + platform unit tests (node --test)
npm start         # serve on http://localhost:3000
```

Open <http://localhost:3000>, create a room, and share the room link
(`http://localhost:3000/r/ABCD`) with other phones/browsers to join. To play across real
phones, expose the port (`npx localtunnel --port 3000` or `ngrok http 3000`).
`npm run dev` runs with `--watch` for auto-reload.

To rebuild the player bank you need the raw dumps locally, then: `node build-wordbank.cjs`.

---

## Deploy (Render — free tier)

Render's free Web Service keeps a long-lived Node process and proxies WebSocket
upgrades — exactly what this needs.

1. Push to GitHub.
2. Render dashboard → **New → Blueprint** at your repo (reads [`render.yaml`](render.yaml)),
   or **New → Web Service**: Runtime `Node`, Build `npm install`, Start `npm start`,
   Health check `/healthz`.
3. Render sets `PORT`; the server reads `process.env.PORT`. The client auto-detects HTTPS
   and connects over `wss://`.

Also runs as-is on Railway or Fly.io. No database — room state lives in memory.
