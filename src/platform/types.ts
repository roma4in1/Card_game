// platform/types.ts — the contract between the game-agnostic room and the games
// it can host. The room (platform/room.ts) owns the lobby, players, host, chat,
// reconnection and the game-selection lifecycle; it knows nothing game-specific.
// Each game is a plugin implementing GameDef: it owns its OWN state (chips,
// cards, decks, whatever) and never sees the lobby.

/** Randomness source returning a float in [0, 1). Injected so games stay testable. */
export type Rng = () => number;

/** Per-call context. Kept OUT of game state so state stays plain-JSON serializable. */
export interface GameContext {
  rng: Rng;
  now: number; // ms timestamp, for time-based logic (turn clocks, timeouts)
}

/** What a game is told about each participant when a match is created. */
export interface PlayerInfo {
  seat: number; // stable seat index (0-based)
  name: string;
}

/** Result of a game once it finishes. */
export interface GameOutcome {
  over: boolean;
  winners: number[]; // [] = ongoing / no single winner, 1 = solo winner, >1 = tie/team
}

/**
 * A hostable game. The room creates one `state` per match via `create`, routes
 * player actions through `act`, asks `view` for each player's private snapshot,
 * and polls `result` to know when the match is over. `state` is opaque to the
 * platform — only the game understands it, and SHOULD be plain-JSON (no
 * functions/Set/Map/class instances) so it can be snapshotted and the rng can
 * stay external.
 *
 * Invariants every game must uphold:
 *  - `view` is private: a seat's view never contains another player's secrets.
 *  - `act` is defensive: `msg` is untrusted client input; validate everything.
 */
export interface GameDef<S = unknown> {
  /** Stable id used in the registry, protocol and client renderer lookup. */
  readonly id: string;
  /** Display name shown in the lobby picker. */
  readonly name: string;
  /** One-line description for the picker. */
  readonly blurb: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /** Optional: reject a start with a reason beyond min/max (e.g. "needs even teams"). */
  validateStart?(seats: number[]): string | null;

  /** Start a fresh match for the given participants. Returns the initial state. */
  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): S;

  /**
   * Apply a player's in-game action. Mutates `state`; returns an error string to
   * reject the action (sent only to that player), or nothing on success (the
   * room re-broadcasts every view).
   */
  act(state: S, seat: number, msg: Record<string, unknown>, ctx: GameContext): { error?: string } | void;

  /** Optional periodic tick (~1Hz) for timeouts / turn clocks; the game stores its own deadlines. */
  tick?(state: S, ctx: GameContext): void;

  /** Optional: a player dropped — resolve anything they owed (e.g. a pending choice). */
  onDisconnect?(state: S, seat: number, ctx: GameContext): void;
  /** Optional: a player came back (usually just clears their "disconnected" flag). */
  onReconnect?(state: S, seat: number): void;

  /** Private snapshot for one seat (`null` ⇒ a spectator: public info only). */
  view(state: S, seat: number | null): Record<string, unknown>;

  /** Whether the match has ended, and who won. */
  result(state: S): GameOutcome;

  /**
   * Optional AI: the next action `seat` should take right now, or `null` if it's
   * not that seat's turn / nothing to do. Used to play seats taken over by bots
   * (e.g. after a player leaves). The returned object is an `act` message.
   */
  bot?(state: S, seat: number, ctx: GameContext): Record<string, unknown> | null;
}

/** A lobby-facing summary of a game (for the host's picker). */
export interface GameSummary {
  id: string;
  name: string;
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
}

export function gameSummary(def: GameDef): GameSummary {
  return {
    id: def.id,
    name: def.name,
    blurb: def.blurb,
    minPlayers: def.minPlayers,
    maxPlayers: def.maxPlayers,
  };
}
