# Win or die 🃏❤️

A two-player online card game of betting and bluffing — poker's nerve with a
rock-paper-scissors twist. Each player opens a link on their phone browser (no
app install) and plays from anywhere. The server is the authoritative referee:
it owns the deck and every hidden card, so neither phone can ever peek at the
other's hand.

TypeScript end to end — a Node + `ws` server and a vanilla HTML/CSS/JS client
served as static files. **No build step.** Node runs the `.ts` server directly
via native type stripping.

---

## How to play

Two players, 35 chips each. A round runs in 10 steps:

1. Each posts a 1-chip blind (pot starts at 2); a dice roll picks who acts first.
2. Deal 2 hole cards to each player.
3. Reveal 1 shared community card (counts in **both** hands).
4. **Betting round 1** — call / raise / fold, no raise cap, all-in allowed.
5. Deal a 3rd hole card to each (3 hole + 1 shared = a 4-card hand).
6. Both players **simultaneously** pick one card to reveal (never the liar). The
   server buffers both choices and reveals them together.
7. **Discussion** — free-text chat. Lie or tell the truth.
8. **Betting round 2.**
9. Resolve any liar cards, reveal hands, evaluate, award the pot.
10. Next round. A draw carries the pot into the next round. The match ends when a
    player can't post the next blind.

### The deck (49 cards)

18 scissor · 12 rock · 12 paper · 6 love · 1 liar.

The deck is a **finite, persistent set**: each round deals 7 cards (4 hole + 1
shared + 2 more hole) and those cards stay out — so what's already been played
thins the deck and rewards paying attention. Only when fewer than 7 cards remain
is a fresh, reshuffled 49-card deck dealt. The table shows the count remaining.

### Hand ranking (1 = strongest, 9 = weakest)

| Rank | Name | Hand |
| --- | --- | --- |
| 1 | Love Wins All | 4 loves |
| 2 | Three Love | 3 loves + 1 any |
| 3 | Four Card | Quad (non-love) |
| 4 | Mix | 1 love + rock + paper + scissor (one of each) |
| 5 | Two Love | 2 loves + 2 any non-love |
| 6 | Two Pair | Two pair (non-love) |
| 7 | Triple | Triple (non-love) |
| 8 | One Pair | One pair (non-love) |
| 9 | One Love | 1 love + 3 non-love (anything except one-of-each) |

Suits use the physical game's colours and hand-signs: **rock** = red ✊,
**paper** = yellow ✋, **scissor** = blue ✌️, **love** = green 🤟 (the ASL "I love
you" sign), **liar** = pink (crossed fingers). The in-game **Ranks** button opens
this full hierarchy at any time, and each round opens with an animated dice roll
for act order.

**Love presence dominates structure.** Count loves first: 2 loves is always rank
5; a single love only escapes to rank 4 if the other three are exactly
rock+paper+scissor — a love next to a pair or a triple is still rank 9.

### Tiebreaks

Rock-paper-scissor is a **cycle** (rock > scissor > paper > rock) — there is no
globally strongest suit. Same-rank hands are broken by:

1. Sub-hierarchy of the non-love remainder: quad > two-pair > triple > pair >
   singles. Higher structure wins.
2. Otherwise cancel the cards both hands share, then compare the survivors by the
   cyclic rock-paper-scissor rule.
3. If everything cancels, it's a draw (ranks 1 and 4 are always draws).

### The liar card

- **As the shared card:** a per-player wildcard — each player independently sets
  its value at showdown.
- **In your hole:** after the step-6 reveal it lets you set *both* of your still-
  hidden cards to any values at showdown.
- It can never be the card you reveal in step 6 (the server enforces this).
- It's resolved at showdown, after all betting, and only ever shown as its chosen
  value.

---

## Project layout

```text
src/
  evaluator.ts        Pure hand evaluation: evaluate(cards) + compare(a, b). No I/O.
  evaluator.test.ts   Unit tests for every rank transition and tiebreak case.
  cards.ts            Deck construction, shuffling (injectable RNG), liar resolution.
  liar.test.ts        Liar-resolution strategy (win-max) over every configuration.
  engine.ts           Pure game engine: rooms, phase machine, betting, simultaneous
                      reveal, liar resolution, chip accounting. No network I/O;
                      deterministic via an injectable RNG.
  engine.test.ts      Deterministic unit tests: betting, all-in refunds, draw
                      carry, reveal buffering, elimination, chip conservation.
  server.ts           Thin transport: static files, WebSocket plumbing, dispatch.
  server.test.ts      End-to-end test: two ws clients play a full round.
  client/
    index.html        Mobile-first single page.
    style.css
    app.js            Thin renderer — shows only the server's private view.
```

The game rules live entirely in `engine.ts` and are pure (no sockets), so they
can be unit-tested deterministically; `server.ts` only moves bytes.

### Anti-cheat guarantees

- Every action is validated server-side. The client cannot deal, resolve a
  winner, or see the opponent's hidden cards or the deck.
- Each client only ever receives its own hand plus public info (pot, chips,
  shared card, revealed cards, claims) and whose turn it is.
- Step-6 reveals are buffered: a player's chosen card is withheld until **both**
  have locked in, then broadcast together.
- The integration test asserts the opponent's hole cards are never present in any
  message and that chips are conserved (always 70 total).

### Reconnection

On join each player gets a secret token, stored in `localStorage`. If the phone
drops its connection, the client auto-reconnects and replays the token to resume
its seat — same chips, same hand, same round.

---

## Run locally

Requires **Node 24+** (for native TypeScript execution — no build step).

```bash
npm install
npm test          # runs evaluator unit tests + the server integration test
npm start         # starts the server on http://localhost:3000
```

Open <http://localhost:3000>, click **Create a game**, then open the room link
(e.g. `http://localhost:3000/r/ABCD`) in a second browser/phone to take seat 2.
To play across two real phones locally, expose the port (e.g. `npx localtunnel
--port 3000` or `ngrok http 3000`) and share that URL.

`npm run dev` runs the server with `--watch` for auto-reload during development.

---

## Deploy (Render — free tier)

Render's free Web Service keeps a long-lived Node process running and proxies
WebSocket upgrades, which is exactly what this server needs.

1. Push this repo to GitHub.
2. In the [Render dashboard](https://dashboard.render.com/) → **New → Blueprint**,
   point it at your repo. Render reads [`render.yaml`](render.yaml) and creates
   the service automatically. (Or **New → Web Service** manually with:
   Runtime `Node`, Build `npm install`, Start `npm start`, Health check
   `/healthz`.)
3. Render sets `PORT` itself; the server reads `process.env.PORT`.
4. Deploy. Your game is live at `https://<your-service>.onrender.com` — share
   `https://<your-service>.onrender.com/r/ABCD`. The client auto-detects HTTPS
   and connects over `wss://`.

> Free instances sleep after inactivity and take a few seconds to wake on the
> first request — fine for a casual game.

### Alternatives

The app is a single stateless-per-room Node process, so it also runs as-is on:

- **Railway** — New Project → Deploy from repo; it auto-detects `npm start` and
  injects `PORT`.
- **Fly.io** — `fly launch` (Node builder), ensure the internal port matches
  `PORT`; Fly proxies WebSockets by default.

No database is needed — game state lives in memory per room.
