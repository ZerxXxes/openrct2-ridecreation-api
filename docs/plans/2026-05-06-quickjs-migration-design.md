# quickjs-ng migration & modernization — design

**Date:** 2026-05-06
**Scope:** Update `ridecreation-api.js` for OpenRCT2 0.5.0 (Duktape → quickjs-ng) and modernize the code to take advantage of the new ES2015+ language features.

## Background

OpenRCT2 0.5.0 swapped its plugin scripting engine from Duktape to quickjs-ng (PR [OpenRCT2#23465](https://github.com/OpenRCT2/OpenRCT2/pull/23465)). The plugin-facing API surface is largely the same, but plugins now have access to modern JavaScript:

- `let` / `const`, classes, arrow functions
- Template literals, destructuring, default parameters, rest/spread
- `Map`, `Set`, `Array.prototype.find`, `Array.prototype.flat`
- **Promises and `async`/`await`**
- Optional chaining `?.`, nullish coalescing `??`
- Each plugin runs in its own isolated context

The current `ridecreation-api.js` is ~1020 lines of pure ES5 written for Duktape. It works, but several spots are unnecessarily painful:

- `placeEntranceExit` is ~180 lines of manually-orchestrated callback fan-out with attempt counters and success flags as locks.
- `deleteAllRides` uses recursive callbacks (`deleteNext()`) to serialize action calls.
- `placeTrackPiece` is ~260 lines of nested callbacks and pyramid-of-doom error handling.
- One spot manually iterates to find a ride with the comment `"find method not available"` — that was a Duktape limitation that's gone now.
- Circuit completion is hard-coded to `(61, 66, 14, dir=0)`, which silently fails for any ride built elsewhere.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| Q1 | Modernize syntax **and** restructure callbacks → Promises/async-await | Biggest readability win; smaller diff than a full rewrite. |
| Q2 | OpenRCT2 0.5.0+ only; no Duktape backwards-compat | Keeping Duktape compat would defeat the refactor. |
| Q3 | Verification = user runs existing Python tests against new plugin | Tests already cover the meaty endpoints. |
| Q4 | Fix hardcoded circuit detection as part of this refactor | Clearly broken; trivial fix while we're in the area. |

## Architecture

Single `ridecreation-api.js` file (OpenRCT2 plugin convention — no bundler). Top-to-bottom:

1. Module-level constants — port config, validation rules (as a `Map` or frozen object), state-category lookup table.
2. State container — `rideTrackStates: Map<number, RideState>` where `RideState = { history, firstPiece, isComplete }`.
3. Helpers
   - `executeAction(action, args) → Promise<result>` — wraps `context.executeAction` callback into a promise; rejects on `result.error`.
   - `getTrackStateCategory(trackType) → string` — same logic as today, possibly via a lookup table.
   - `findStationPieces(rideId)`, `findPlacedTrackElement(ride, position)`, `entranceExitPositionsFor(stationPiece)` — extractions from the existing inline code.
4. Endpoint handlers — one `async` function per endpoint. Each returns a payload object on success or throws on failure.
5. Dispatcher — `Map<endpointName, handler>` lookup; wraps the handler call in a try/catch that converts thrown errors into `{ success: false, error }` responses.
6. Connection handler — newline-delimited JSON over TCP. Same wire protocol.
7. `main()` + `registerPlugin(...)` at the bottom (unchanged shape, with bumped `targetApiVersion`).

## Wire protocol

**Unchanged.** Every endpoint's request shape and response shape is byte-identical. The existing Python clients (`test_validation.py`, `test_entrance_exit.py`, `test_station.sh`) keep working without changes.

## Concrete cleanups

### 1. Promisified `executeAction`

```js
function executeAction(action, args) {
  return new Promise((resolve, reject) => {
    context.executeAction(action, args, result => {
      if (!result || (result.error && result.error !== "")) {
        reject(new Error(result?.error ?? "Unknown error"));
      } else {
        resolve(result);
      }
    });
  });
}
```

Every `context.executeAction(...)` call site becomes one or more `await executeAction(...)` lines.

### 2. `placeEntranceExit` (~180 lines → ~40 lines)

```js
async function placeEntranceExit({ rideId }) {
  const stationPieces = findStationPieces(rideId);
  if (stationPieces.length === 0) throw new Error(`No station pieces for ride ${rideId}`);

  let entrance = null, exit = null;
  for (const piece of stationPieces) {
    const { entrance: entrancePos, exit: exitPos } = entranceExitPositionsFor(piece);
    if (!entrance) entrance = await tryPlace(rideId, entrancePos, false);
    if (!exit)     exit     = await tryPlace(rideId, exitPos, true);
    if (entrance && exit) break;
  }
  // build response — same fields/shape as today (entrance, exit, message, optional warning)
}
```

### 3. `deleteAllRides` (recursive callback → loop)

```js
const rides = [...map.rides];
if (rides.length === 0) return "No rides to delete.";
for (const ride of rides) {
  try {
    await executeAction("ridedemolish", { ride: ride.id, modifyType: 0 });
    rideTrackStates.delete(ride.id);
  } catch (e) {
    console.log(`Error demolishing ride ${ride.id}: ${e.message}`);
  }
}
return "Deleted all rides.";
```

### 4. `placeTrackPiece` (linearized)

The body becomes: validate params → `await executeAction("trackplace", ...)` → `findPlacedTrackElement(...)` → build iterator → record history → respond. The "look on neighboring tiles" fallback for finding the placed element is extracted to its own helper.

### 5. Circuit-detection fix

`RideState.firstPiece = { x, y, z, direction }` is set on the **first** call to `placeTrackPiece` for a ride. Circuit completion compares `nextEndpoint` against `firstPiece` instead of the hardcoded `(61, 66, 14, 0)`. Response field name (`isCircuitComplete`) and shape unchanged.

### 6. `Array.prototype.find`

Ride lookup in `placeEntranceExit` becomes `[...map.rides].find(r => r.id === rideId)`. The "find method not available" workaround comment goes away.

### 7. Modern syntax everywhere

- `var` → `const` / `let`
- String concatenation → template literals
- Old indexed `for` → `for...of`
- Function expressions in callbacks → arrow functions
- Top-of-handler `request.params.X` checks → destructuring + early throw
- Optional chaining `?.` in error guards

## Error flow

```js
async function dispatch(request) {
  if (!request.endpoint) return { success: false, error: "Missing endpoint" };
  const handler = endpoints.get(request.endpoint);
  if (!handler) return { success: false, error: `Unknown endpoint: ${request.endpoint}` };
  try {
    const payload = await handler(request.params ?? {});
    return { success: true, payload };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

Handlers throw on bad input or game-action failure. The promisified `executeAction` rejects on `result.error`, so failed actions surface as exceptions automatically — no scattered `callback({ success: false, error: ... }); return;` blocks.

**Partial-success exception:** a few endpoints (currently `placeEntranceExit`) return `success: true` with a `warning` field when only one of two operations succeeded. Handlers preserve this by returning the payload directly; only true failures throw.

## Plugin metadata

`targetApiVersion: 103` will be bumped to whatever 0.5.0 expects. To be confirmed against `openrct2.d.ts` or the OpenRCT2 0.5.0 changelog during implementation.

## Testing

1. User runs `test_validation.py`, `test_entrance_exit.py`, and `test_station.sh` against the new plugin in OpenRCT2 0.5.0.
2. Iterate on any failures.
3. **Behavior change to flag:** `isCircuitComplete` will now actually fire for arbitrary start positions (per Q4). Field name and shape unchanged, but RL agents that relied on the old never-fires-unless-you-build-at-(67,66,14) behavior will see a difference.

## Out of scope

- Splitting into multiple files / introducing a bundler.
- TypeScript.
- Any new endpoints or feature additions.
- Changing the wire protocol.
- Adding automated tests beyond what already exists.
