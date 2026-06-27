# Game spec: "Memory Match" — multilingual word-image concentration game

A digital implementation of the classic Memory / Concentration game for 2-4 players,
with two twists: cards match WORD-to-IMAGE (not identical pairs), and each player sees
the word cards in THEIR OWN chosen language (English, French, or Korean) on the same
shared board simultaneously. The board state (face-up/face-down, who owns what) is
identical for everyone; only the LANGUAGE of word cards differs per player.

## Components (digital)
- A pluggable **concept dataset**: `concepts.json`, each entry
  `{ id, emoji, en, fr, ko }`. The "image" side is an emoji (renders identically on all
  clients, no asset hosting). NOTE: Claude Code may substitute real hosted image files
  instead of emoji - the card identity is just "concept id + side", so the image
  representation is swappable without touching game logic.
- A **deck** built from a random subset of concepts. Pairs-per-game is configurable
  **10 to 20** (so 20-40 cards total). Each chosen concept produces exactly TWO cards:
  one WORD card and one IMAGE card.
- Cards laid out in a grid, all face-down to start.
- Per-player **score** = number of pairs that player has matched.
- Per-player **language** setting: 'en' | 'fr' | 'ko', chosen independently at join.

## Objective
Match the most pairs. A pair is one WORD card + the IMAGE card of the SAME concept
(e.g. the word "apple"/"pomme"/"사과" + the 🍎 image). Most pairs when the board is
cleared wins.

## Card model (important)
- Every card is `{ cardId, conceptId, side: 'word'|'image', faceUp, matchedBy }`.
- A WORD card's displayed text depends on the VIEWING player's language: concept 1 shows
  "apple" to an EN player, "pomme" to FR, "사과" to KO - same card, same position.
- An IMAGE card shows the concept's emoji (or image), identical to all players.
- Card identity for matching is the conceptId + side - language-independent.

## Match rule (enforce exactly)
- Two flipped cards MATCH if and only if they have the SAME conceptId AND one is a
  WORD card and the other is an IMAGE card.
- WORD+WORD never matches; IMAGE+IMAGE never matches (a concept has exactly one of each,
  so this can't even arise, but enforce it). Each image corresponds to exactly one word
  (its own concept's word) and vice versa - no cross-concept matches exist.

## Turn structure (one player's turn)
1. The active player flips ONE face-down card (it becomes face-up to everyone).
2. The active player flips a SECOND face-down card.
3. Resolve:
   - **Match** (same concept, word+image): both cards STAY face-up, marked as matched by
     this player; the player SCORES 1 pair and TAKES ANOTHER TURN (flip two more).
   - **No match**: both cards flip back face-down (after a brief reveal so all players
     see them), and play passes to the NEXT player.
4. Continue until all pairs are matched (board cleared).

### Key constraints (enforce these)
- Only the active player may flip cards. A player flips exactly two per attempt (unless
  the board has one pair left etc. - standard).
- A card already matched (face-up, owned) or already face-up this turn cannot be chosen
  as the second flip (no flipping the same card twice to auto-match).
- Matched cards remain face-up for the rest of the game.
- Server controls the shuffle and the face-down identities; see anti-cheat below.

## End of game
- The game ends when every pair is matched (all cards face-up).
- Most pairs matched wins.
- Tiebreak: simultaneous-clear can't happen (turns are sequential); on equal pairs ->
  shared victory.

## Outcome (hub scorecard)
- Win/lose by pair count. Return a result the hub renders generically: per-player pair
  counts, the winner(s), and the final board (all concepts revealed).

## Turn order
- Fixed seat order. A matching player repeats; a non-matching player passes. Round/turn
  cycling continues until the board is cleared.

## Build notes (plugin contract - mirror the Love & Liar plugin)
- **Authoritative server** owns the shuffled deck and which concept is under each
  face-down card. Clients must NOT learn face-down card identities - only face-up cards
  (currently flipped or already matched) reveal their concept. This IS a hidden-info
  game: the face-down values are secret until flipped, so `view` redacts unflipped cards.
- **Per-player language is a SECOND, novel reason `view` differs per player** (beyond
  secrecy): word cards that ARE visible (face-up/matched) render in the viewing player's
  language. So `view` does both: hide face-down identities, AND localize visible word
  cards to the viewer's language. The face-up/face-down state and ownership are identical
  for all players - only word TEXT differs.
- **Pluggable dataset + config**: `{ pairs: 10..20, language per player, conceptBank }`.
  Draw `pairs` concepts at random; build 2 cards each; shuffle positions. Do NOT hardcode
  concepts in game logic.
- **Actions** (dispatched opaquely by the hub):
  - `flipCard { cardId }` - legal only for the active player, only on a face-down,
    unmatched card, at most two per attempt. Server reveals it (to all), and on the second
    flip resolves match/no-match.
  - `setLanguage { lang }` - a player sets their own display language (at join; allow
    changing between turns if you like). Affects only that player's `view`.
- **view(state, playerId)**:
  - For each card: its position, side (word/image), faceUp, matchedBy.
  - If faceUp or matched: reveal conceptId; for WORD cards, the text in playerId's
    language; for IMAGE cards, the emoji/image.
  - If face-down: NO conceptId, NO text - just "face-down".
  - Plus scores, whose turn, this-turn's flipped cards, legal actions.
- Core state: { cards: [{cardId, conceptId, side, faceUp, matchedBy}], scores: {pid:n},
  turn: pid, flippedThisAttempt: [cardId], languages: {pid: 'en'|'fr'|'ko'} }.

## Tests to include
- Match logic: same conceptId + word/image -> match; same concept but somehow same side
  -> no match; different concepts -> no match.
- Matched pair stays up, scorer goes again; non-match flips both down and passes turn.
- Anti-cheat: face-down cards' conceptId never appears in any player's `view`; only
  flipped/matched cards reveal identity.
- Localization: the SAME word card renders "apple"/"pomme"/"사과" in EN/FR/KO views
  respectively; image cards identical across languages; face-up/face-down state identical
  across languages.
- Deck build: `pairs` in [10,20]; exactly 2 cards per chosen concept; positions shuffled.
- Can't flip the same card twice in one attempt; can't flip an already-matched card.
- End + win: board clears -> most pairs wins; equal -> shared victory.
