# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the OpenRCT2 Ride Creation API — a TCP-based JSON API plugin for OpenRCT2 that allows programmatic control of ride construction. It is designed for reinforcement learning agents to build roller coasters and evaluate their performance using in-game ratings.

The plugin targets OpenRCT2 0.5.0+ (quickjs-ng scripting engine) and is written in modern JavaScript (ES2015+ with async/await, `const`/`let`, classes, `Map`, template literals, etc.). The plugin requires `TrackSegment.getNextValidSegments(rideId)` from OpenRCT2 PR [#25840](https://github.com/OpenRCT2/OpenRCT2/pull/25840), so `minApiVersion` is set to 114 — older OpenRCT2 builds will reject the plugin at load time.

## Key Architecture

### Main components (`ridecreation-api.js`)

1. **TCP server**
   - Listens on port 8080 (or a random port in `[20000, 30000]` if `RANDOM_PORT` is set at the top of `main()`).
   - Newline-delimited JSON messages.
   - Connection handler buffers partial reads and dispatches each complete line through `processRequest()`.

2. **Helpers**
   - `executeAction(action, args) → Promise<result>` — Promise wrapper around `context.executeAction`. Rejects with `new Error(message)` on game-action failure.
   - `runHandler(handlerPromise, callback)` — converts a resolved/rejected promise into the dispatcher's `{success, payload | error}` response shape. Wraps every handler invocation; handlers throw on failure rather than calling the callback themselves.

3. **Dispatcher**
   - `endpoints: Map<string, (params) => Promise<payload>>` — single source of truth for endpoint registration. Adding a new endpoint = write `async function handleX(params)` and add one entry to the Map.
   - `processRequest(request, callback)` — looks up the endpoint, calls the handler with `request.params`, pipes the promise through `runHandler`. Returns explicit `{success: false, error: "Unknown endpoint: <name>"}` for unregistered endpoints (the old switch-based dispatcher silently dropped these — clients hung).

4. **Track state management**
   - `rideTrackStates: Map<rideId, RideState>` where `RideState = { history, firstPiece?, isComplete? }`.
   - `history` is the chronological list of pieces placed via the API (used for `deleteLastTrackPiece` and `getValidNextPieces`).
   - `firstPiece` is recorded on the first `placeTrackPiece` call for a ride and used for circuit-completion detection (compares `nextEndpoint` against the first piece's start position). Reset to `null` when `history` empties via `deleteLastTrackPiece`.
   - `isComplete` mirrors the latest `isCircuitComplete` response; reset to `false` on full undo.
   - State is created automatically by `createRide` and on first `placeTrackPiece` if missing (so manually-created rides also work). Cleared by `deleteAllRides`.

5. **Track validation**
   - `getValidNextPieces` delegates to the native `segment.getNextValidSegments(rideId)` (added in OpenRCT2 PR #25840), which is ride-type-aware (filters covered variants, gates `slopeSteepUp`/`curveVertical`, etc.). The plugin holds no validation tables of its own — the previous `trackConnectionRules` / `getTrackStateCategory` pair was removed in favor of the native call.
   - For empty history (no piece placed yet) `getValidNextPieces` returns a conservative fixed set: Flat / EndStation / BeginStation / MiddleStation (types `[0, 1, 2, 3]`). Replacing this with a ride-type-aware "valid initial pieces" lookup is gated on a future upstream API.
   - `serializeTrackSegment(seg)` is the single source of truth for the wire shape of a track segment; both `getValidNextPieces.validSegments` and `getAllTrackSegments` go through it.

### API endpoints

Registered in the `endpoints` Map. Each handler is `async`; throws → `{success: false, error}`; returns → `{success: true, payload}`.

- `createRide` — create a new ride. Now requires `inspectionInterval` (defaulted to 2 = `every30Minutes` if the client doesn't pass it; OpenRCT2 0.5.0's strict parameter visitor errors on missing fields).
- `placeTrackPiece` — place a track piece; records to history and updates circuit-detection state.
- `placeEntranceExit` — scan station pieces, place entrance and exit on perpendicular sides; tries each station in turn until both succeed.
- `deleteLastTrackPiece` — pop the last placed piece; resets `firstPiece` and `isComplete` when history empties.
- `getValidNextPieces` — return the valid follow-on track pieces for the most-recently-placed piece (or the conservative initial set if history is empty). Backed by native `segment.getNextValidSegments(rideId)`; response includes both `validPieces` (numeric type IDs, wire-compatible with pre-migration clients) and `validSegments` (rich segment objects via `serializeTrackSegment`). `stateCategory` is retained as a key but is always `null` (the local classification no longer exists).
- `getRideStats` — return excitement/intensity/nausea ratings (each value is `ride.X / 100`).
- `startRideTest` — set ride status to `testing` (game action `ridesetstatus` with `status: 2`).
- `listAllRides` — list all rides in the park (`{id, name, type}` per ride).
- `deleteAllRides` — demolish every ride sequentially via `ridedemolish`; per-ride failures are logged and the loop continues.
- `getAllTrackSegments` — return every available track segment with its descriptive fields.
- `listLoadedRideObjects` — return loaded ride objects (`{index, identifier, name, rideType}`). Useful for discovering valid `rideObject` indices before calling `createRide`.

## Development notes

### Running the plugin

1. Place `ridecreation-api.js` in the OpenRCT2 plugins folder (typically `~/.config/OpenRCT2/plugin/` on Linux).
2. Start OpenRCT2 0.5.0+ with the developer console enabled.
3. The TCP server starts automatically on port 8080.
4. Connect via TCP with newline-delimited JSON.

### Testing

No in-process unit tests exist (the plugin requires a live OpenRCT2 host to run). Verification is end-to-end:

1. Load the plugin in OpenRCT2 0.5.0+.
2. Run the existing Python harness: `python3 test_entrance_exit.py`, `python3 test_validation.py`, `bash test_station.sh`.
3. For ad-hoc probing, raw `nc`/`netcat` works but use a longer timeout (`-q 5` or more) for `placeEntranceExit` and `listLoadedRideObjects` since they iterate the map.

For syntax-only checks during development: `node --check ridecreation-api.js`. Note that the file references plugin globals (`network`, `context`, `map`, `objectManager`) that aren't defined in node — `--check` only validates syntax, not symbol resolution.

### Common tasks

- **Add a new endpoint**: write `async function handleX(params)` and add `["x", params => handleX(params)]` to the `endpoints` Map. The dispatcher and error-conversion plumbing are uniform.
- **Change the wire shape of a track segment**: update `serializeTrackSegment()` — both `getValidNextPieces` and `getAllTrackSegments` consume it, so they stay in sync automatically.
- **Debug game-action failures**: every handler logs to the OpenRCT2 console via `console.log`. The plugin's wire response only contains the final error string; per-attempt diagnostics are in the console.

### Calling new game actions

OpenRCT2 0.5.0's `JSToGameActionParameterVisitor` is **strict** about missing JSON fields — it sets `_error = true` on any field the action's `AcceptParameters` visits but the JSON omits, and `QueryOrExecuteAction` then throws `"Invalid action parameters."` before the action runs. This is a behavior change from the lenient Duktape visitor in pre-0.5.0 (which silently defaulted missing fields to 0).

When wiring a new action:

1. Read the action's `AcceptParameters` in the OpenRCT2 source (`src/openrct2/actions/`) to enumerate every field it visits.
2. Pass every field in your `executeAction(action, args)` call. CoordsXY/CoordsXYZ/CoordsXYZD `Visit` overloads expand to `{x}`, `{x, y, z}`, and `{x, y, z, direction}` field sets respectively.
3. If the action grows a new field upstream, the plugin will start failing with `"Invalid action parameters."`. Treat that error as a signal to re-audit the action's parameter list.

## Important implementation details

- **Coordinates**: tile-based on input; converted to OpenRCT2 game (pixel) units inside handlers (`*32` for x/y, `*8` for z).
- **Direction values**: `0`=west, `1`=north, `2`=east, `3`=south.
- **Chain lift**: bit 0 of `trackPlaceFlags`. Set automatically when `placeTrackPiece` receives `hasChainLift: true`. Only meaningful on upward slopes (track types 4, 5, 6).
- **Ride IDs are reused** after deletion. State is cleared on `deleteAllRides` and re-initialized fresh by `createRide` (and lazily by `placeTrackPiece` for manually-created rides).
- **Wire protocol**: stable. Handler return values are wrapped as `{success: true, payload}`; thrown errors become `{success: false, error: <message>}`. Error message strings are intentionally preserved character-for-character with pre-migration wording so existing clients matching on them keep working.
