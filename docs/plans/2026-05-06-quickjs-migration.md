# quickjs-ng Migration & Modernization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update `ridecreation-api.js` for OpenRCT2 0.5.0 (quickjs-ng) and modernize from ES5 callbacks to ES2015+ with Promises/async-await, while keeping the wire protocol byte-identical.

**Architecture:** Single-file plugin. Refactor incrementally by adding new helpers first, then converting endpoints one-by-one to `async` handlers (each commit leaves the plugin working). After all endpoints are converted, replace the giant `switch` dispatcher with a `Map<endpoint, handler>` lookup with central try/catch.

**Tech Stack:** JavaScript (ES2015+), OpenRCT2 plugin API (quickjs-ng), Python TCP test clients.

**Design doc:** `docs/plans/2026-05-06-quickjs-migration-design.md`

**Verification model:** No unit-test framework runs against this plugin (it requires a live OpenRCT2 game). Each task's test step is `node --check ridecreation-api.js` for syntax validity. At the end, the user runs `test_validation.py`, `test_entrance_exit.py`, `test_station.sh` against the plugin loaded into OpenRCT2 0.5.0.

---

## Task 1: Bump `targetApiVersion`

**Files:**
- Modify: `ridecreation-api.js:1017` (the `registerPlugin({...})` call)

**Step 1: Look up the current target API version for OpenRCT2 0.5.0**

Run:
```bash
gh api repos/OpenRCT2/OpenRCT2/contents/distribution/openrct2.d.ts \
  | jq -r '.content' | base64 -d \
  | grep -E "ApiVersion|apiVersion" | head -20
```

Also check the changelog for the API version mentioned by PR #23465:
```bash
gh api repos/OpenRCT2/OpenRCT2/contents/distribution/changelog.txt \
  | jq -r '.content' | base64 -d | head -30
```

If neither is conclusive, fall back to fetching the OpenRCT2 0.5.0 release notes:
```bash
gh release view --repo OpenRCT2/OpenRCT2 v0.5.0 --json body | jq -r .body | head -50
```

Record the version number (e.g. 110, 120 — whatever is current).

**Step 2: Edit the registerPlugin call**

Change:
```js
targetApiVersion: 103,
```
to (replace `XXX` with the discovered version):
```js
targetApiVersion: XXX,
```

Also bump `version: "0.1"` to `version: "0.2"` to mark the migration:
```js
version: "0.2",
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output (success).

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "bump targetApiVersion for OpenRCT2 0.5.0 (quickjs-ng)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `executeAction` Promise wrapper

This is additive — no existing call sites change yet.

**Files:**
- Modify: `ridecreation-api.js` (add helper near the top of `main()`, before `trackConnectionRules`)

**Step 1: Add the helper**

Insert after `console.log("Ride API server listening on port " + port + ".");` (currently line 62) and before `// Track validation rules...` (currently line 64):

```js
    // Promise-wrapped context.executeAction. Rejects on result.error so
    // failed actions surface as exceptions in async handlers.
    function executeAction(action, args) {
        return new Promise((resolve, reject) => {
            context.executeAction(action, args, result => {
                if (!result || (result.error && result.error !== "")) {
                    reject(new Error((result && result.error) || "Unknown error"));
                } else {
                    resolve(result);
                }
            });
        });
    }
```

**Step 2: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 3: Commit**

```bash
git add ridecreation-api.js
git commit -m "add executeAction Promise wrapper

Additive helper. No call sites converted yet — used by upcoming
endpoint refactors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Convert `rideTrackStates` to a `Map`

Plain object keyed by ride ID becomes a `Map`. Updates every read/write site.

**Files:**
- Modify: `ridecreation-api.js` (state declaration + every access site)

**Step 1: Find every access site**

Run:
```bash
grep -n "rideTrackStates" ridecreation-api.js
```
Expected matches (line numbers approximate): the declaration, plus reads/writes in `deleteAllRides`, `placeTrackPiece`, `getValidNextPieces`, `deleteLastTrackPiece`, `createRide`. Track them all before editing.

**Step 2: Change the declaration**

```js
    // Track state storage (ride ID -> RideState)
    var rideTrackStates = new Map();
```

**Step 3: Update all access sites**

| Old | New |
|---|---|
| `rideTrackStates[rideId]` (read) | `rideTrackStates.get(rideId)` |
| `rideTrackStates[rideId] = X` | `rideTrackStates.set(rideId, X)` |
| `rideTrackStates[rideId] = rideTrackStates[rideId] \|\| { history: [] }` | extract to: `var s = rideTrackStates.get(rideId); if (!s) { s = { history: [] }; rideTrackStates.set(rideId, s); }` |
| `delete rideTrackStates[rideId]` | `rideTrackStates.delete(rideId)` |

Specific spots to update (line numbers from current file):
- L296: `delete rideTrackStates[ride.id];` → `rideTrackStates.delete(ride.id);`
- L570: the `||=` assignment — split into get/set as shown above
- L573: `rideTrackStates[request.params.ride].history.push(...)` → first assign `var s = rideTrackStates.get(rideId);` then `s.history.push(...)`
- L591: `rideTrackStates[request.params.ride].isComplete = ...` → `s.isComplete = ...` (reuse `s` from above)
- L630, L900: `var state = rideTrackStates[rideId];` → `var state = rideTrackStates.get(rideId);`
- L990: `rideTrackStates[result.ride] = { history: [] };` → `rideTrackStates.set(result.ride, { history: [] });`

**Step 4: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 5: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert rideTrackStates to a Map

Numeric ride IDs and proper deletion semantics fit a Map better than
a plain object.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add async-handler adapter

Adds infrastructure to run an `async` function and pipe its result/error into the existing `callback({success, payload|error})` shape. Lets us convert endpoints one-by-one without touching the dispatcher yet.

**Files:**
- Modify: `ridecreation-api.js` (add helper near `executeAction`)

**Step 1: Add the helper**

Insert immediately after the `executeAction` helper from Task 2:

```js
    // Run an async handler and convert its resolved value / thrown error
    // into the standard {success, payload|error} response shape.
    function runHandler(handlerPromise, callback) {
        handlerPromise
            .then(payload => callback({ success: true, payload }))
            .catch(e => callback({ success: false, error: e && e.message ? e.message : String(e) }));
    }
```

**Step 2: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 3: Commit**

```bash
git add ridecreation-api.js
git commit -m "add runHandler adapter for incremental async migration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Convert `listAllRides` to async handler

Smallest endpoint — good first conversion to validate the pattern.

**Files:**
- Modify: `ridecreation-api.js` (replace the `case "listAllRides":` body)

**Step 1: Define the async handler**

Add this function inside `main()`, near the bottom, before the closing `}` of `main()`. Group all endpoint handlers together as we convert them.

```js
    async function handleListAllRides() {
        const ridesArray = [];
        map.rides.forEach(ride => {
            ridesArray.push({ id: ride.id, name: ride.name, type: ride.type });
        });
        return ridesArray;
    }
```

**Step 2: Replace the switch case body**

Replace:
```js
            case "listAllRides":
                var ridesArray = [];
                map.rides.forEach(function (ride) {
                    ridesArray.push({
                        id: ride.id,
                        name: ride.name,
                        type: ride.type
                    });
                });
                callback({
                    success: true,
                    payload: ridesArray
                });
                break;
```
With:
```js
            case "listAllRides":
                runHandler(handleListAllRides(), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert listAllRides to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Convert `getAllTrackSegments` to async handler

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

Add next to `handleListAllRides`:

```js
    async function handleGetAllTrackSegments() {
        return context.getAllTrackSegments().map(seg => ({
            type: seg.type,
            description: seg.description,
            trackGroup: seg.trackGroup,
            length: seg.length,
            beginZ: seg.beginZ,
            endZ: seg.endZ,
            beginDirection: seg.beginDirection,
            endDirection: seg.endDirection,
            beginBank: seg.beginBank,
            endBank: seg.endBank,
        }));
    }
```

**Step 2: Replace the switch case**

Replace the `case "getAllTrackSegments":` body with:
```js
            case "getAllTrackSegments":
                runHandler(handleGetAllTrackSegments(), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert getAllTrackSegments to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Convert `getRideStats` to async handler

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleGetRideStats(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");
        const ride = map.getRide(rideId);
        if (!ride) throw new Error("Ride not found");
        return {
            excitement: ride.excitement / 100,
            intensity: ride.intensity / 100,
            nausea: ride.nausea / 100,
        };
    }
```

**Step 2: Replace the switch case**

```js
            case "getRideStats":
                runHandler(handleGetRideStats(request.params), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert getRideStats to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Convert `startRideTest` to async handler

First handler to use `await executeAction(...)`.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleStartRideTest(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");
        await executeAction("ridesetstatus", { ride: rideId, status: 2 });
        return `Ride ${rideId} started in test mode.`;
    }
```

Note: error wrapping for the executeAction failure happens automatically via the rejected Promise → caught in `runHandler` → returned as `{success: false, error}`. The error message will be the raw game-action error (e.g. "..."), not "Failed to start ride test: ...". This is a minor message change. **If the existing wording matters,** wrap it instead:
```js
try {
    await executeAction("ridesetstatus", { ride: rideId, status: 2 });
} catch (e) {
    throw new Error(`Failed to start ride test: ${e.message}`);
}
```

Use the wrapped form to keep error wording stable for clients.

**Step 2: Replace the switch case**

```js
            case "startRideTest":
                runHandler(handleStartRideTest(request.params), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert startRideTest to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Convert `createRide` to async handler

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleCreateRide(params) {
        if (!params
            || typeof params.rideType !== "number"
            || typeof params.rideObject !== "number"
            || typeof params.entranceObject !== "number"
            || typeof params.colour1 !== "number"
            || typeof params.colour2 !== "number") {
            throw new Error("Missing or invalid parameters for createRide");
        }
        let result;
        try {
            result = await executeAction("ridecreate", {
                rideType: params.rideType,
                rideObject: params.rideObject,
                entranceObject: params.entranceObject,
                colour1: params.colour1,
                colour2: params.colour2,
            });
        } catch (e) {
            throw new Error(`Failed to create ride: ${e.message}`);
        }
        if (typeof result.ride !== "number") throw new Error("Failed to create ride: no ride id returned");
        rideTrackStates.set(result.ride, { history: [] });
        console.log(`Initialized fresh track state for ride ${result.ride}`);
        return { rideId: result.ride };
    }
```

**Step 2: Replace the switch case**

```js
            case "createRide":
                runHandler(handleCreateRide(request.params), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert createRide to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Convert `deleteAllRides` to async handler

Kills the recursive `deleteNext()` callback chain.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleDeleteAllRides() {
        const rides = [];
        map.rides.forEach(r => rides.push(r));
        if (rides.length === 0) return "No rides to delete.";
        for (const ride of rides) {
            try {
                await executeAction("ridedemolish", { ride: ride.id, modifyType: 0 });
                rideTrackStates.delete(ride.id);
                console.log(`Cleared track state for deleted ride ${ride.id}`);
            } catch (e) {
                console.log(`Error demolishing ride ${ride.id}: ${e.message}`);
            }
        }
        return "Deleted all rides.";
    }
```

**Step 2: Replace the switch case**

```js
            case "deleteAllRides":
                runHandler(handleDeleteAllRides(), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert deleteAllRides to async handler

Replaces the recursive deleteNext() callback chain with a sequential
for...of + await loop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Convert `getValidNextPieces` to async handler

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleGetValidNextPieces(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");
        const state = rideTrackStates.get(rideId);
        if (!state || !state.history || state.history.length === 0) {
            return {
                validPieces: [0, 1, 2, 3],
                lastTrackType: null,
                stateCategory: "initial",
            };
        }
        const lastPiece = state.history[state.history.length - 1];
        const stateCategory = getTrackStateCategory(lastPiece.trackType, false);
        const rules = trackConnectionRules[stateCategory];
        const position = {
            x: lastPiece.nextX,
            y: lastPiece.nextY,
            z: lastPiece.nextZ,
            direction: lastPiece.nextDirection,
        };
        if (!rules) {
            console.log(`Warning: No rules for state category: ${stateCategory} track type: ${lastPiece.trackType}`);
            return {
                validPieces: [0, 16, 17, 42, 43],
                lastTrackType: lastPiece.trackType,
                stateCategory,
                position,
            };
        }
        return {
            validPieces: rules.allowed,
            lastTrackType: lastPiece.trackType,
            stateCategory,
            position,
        };
    }
```

**Step 2: Replace the switch case**

```js
            case "getValidNextPieces":
                runHandler(handleGetValidNextPieces(request.params), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert getValidNextPieces to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Convert `deleteLastTrackPiece` to async handler

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Define the handler**

```js
    async function handleDeleteLastTrackPiece(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");
        const state = rideTrackStates.get(rideId);
        if (!state || !state.history || state.history.length === 0) {
            throw new Error(`No track pieces to delete for ride ${rideId}`);
        }
        const lastPiece = state.history[state.history.length - 1];
        console.log(
            `Attempting to remove track piece at tile: ${lastPiece.placedTileX} ${lastPiece.placedTileY} ` +
            `element index: ${lastPiece.elementIndex} trackType: ${lastPiece.trackType}`
        );
        try {
            await executeAction("trackremove", {
                x: lastPiece.placedTileX * 32,
                y: lastPiece.placedTileY * 32,
                z: lastPiece.z * 8,
                direction: lastPiece.direction,
                trackType: lastPiece.trackType,
                sequence: 0,
            });
        } catch (e) {
            console.log(`Failed to remove track piece: ${e.message}`);
            throw new Error(`Failed to remove track piece: ${e.message}`);
        }
        console.log("Successfully removed track piece");
        state.history.pop();
        const response = {
            message: `Track piece removed from ride ${rideId}`,
            piecesRemaining: state.history.length,
            nextEndpoint: null,
            lastTrackType: null,
        };
        if (state.history.length > 0) {
            const newLast = state.history[state.history.length - 1];
            response.nextEndpoint = {
                x: newLast.nextX,
                y: newLast.nextY,
                z: newLast.nextZ,
                direction: newLast.nextDirection,
            };
            response.lastTrackType = newLast.trackType;
        }
        return response;
    }
```

**Step 2: Replace the switch case**

```js
            case "deleteLastTrackPiece":
                runHandler(handleDeleteLastTrackPiece(request.params), callback);
                break;
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert deleteLastTrackPiece to async handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Convert `placeTrackPiece` to async handler + fix circuit detection

Largest endpoint. Linearizes the callback pyramid and replaces the hardcoded `(61, 66, 14, 0)` start position with the recorded first-piece position.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Add the placed-element search helper**

Before the endpoint handlers section:

```js
    // Search for the just-placed track element on the result tile, then
    // surrounding tiles. Returns { tile, element, elementIndex, tileX, tileY }
    // or null.
    function findPlacedTrackElement(rideId, resultPosition) {
        const placedTileZ = resultPosition.z;
        const offsets = [
            [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
            [-1, -1], [-1, 1], [1, -1], [1, 1],
        ];
        const baseX = Math.floor(resultPosition.x / 32);
        const baseY = Math.floor(resultPosition.y / 32);
        for (const [dx, dy] of offsets) {
            const tx = baseX + dx;
            const ty = baseY + dy;
            const tile = map.getTile(tx, ty);
            if (!tile) continue;
            const tolerance = (dx === 0 && dy === 0) ? 8 : 16;
            for (let i = 0; i < tile.numElements; i++) {
                const elem = tile.elements[i];
                if (elem.type === "track" && elem.ride === rideId
                    && Math.abs(elem.baseZ - placedTileZ) <= tolerance) {
                    return { tile, element: elem, elementIndex: i, tileX: tx, tileY: ty };
                }
            }
        }
        return null;
    }
```

**Step 2: Add the handler**

```js
    async function handlePlaceTrackPiece(params) {
        const requiredParams = [
            "tileCoordinateX", "tileCoordinateY", "tileCoordinateZ", "direction", "ride",
            "trackType", "rideType", "brakeSpeed", "colour",
            "seatRotation", "trackPlaceFlags", "isFromTrackDesign",
        ];
        if (!params) throw new Error("Missing parameters for placeTrackPiece");
        for (const key of requiredParams) {
            if (typeof params[key] === "undefined") throw new Error(`Missing parameter: ${key}`);
        }

        const pixelCoordinateX = params.tileCoordinateX * 32;
        const pixelCoordinateY = params.tileCoordinateY * 32;
        const pixelCoordinateZ = params.tileCoordinateZ * 8;
        let flags = params.trackPlaceFlags;
        if (params.hasChainLift === true) flags = flags | 1;

        const isStationPiece = (params.trackType === 1 || params.trackType === 2 || params.trackType === 3);
        if (isStationPiece) {
            console.log(`Station piece placed - Type: ${params.trackType} for ride ${params.ride}`);
            console.log("Note: Use placeEntranceExit endpoint to add entrance/exit after station is complete");
        }

        let result;
        try {
            result = await executeAction("trackplace", {
                x: pixelCoordinateX,
                y: pixelCoordinateY,
                z: pixelCoordinateZ,
                direction: params.direction,
                ride: params.ride,
                trackType: params.trackType,
                rideType: params.rideType,
                brakeSpeed: params.brakeSpeed,
                colour: params.colour,
                seatRotation: params.seatRotation,
                trackPlaceFlags: flags,
                isFromTrackDesign: params.isFromTrackDesign,
            });
        } catch (e) {
            throw new Error(`Failed to place track piece: ${e.message}`);
        }

        console.log(`Track placed successfully at result position: ${JSON.stringify(result.position)}`);

        const placed = findPlacedTrackElement(params.ride, result.position);
        if (!placed) throw new Error("Could not find track element on any nearby tile");
        console.log(`Found track element at index: ${placed.elementIndex} on tile: ${placed.tileX} ${placed.tileY}`);

        const iteratorPos = { x: placed.tileX * 32, y: placed.tileY * 32 };
        const iterator = map.getTrackIterator(iteratorPos, placed.elementIndex);
        if (!iterator) throw new Error("Track iterator not available");

        if (!iterator.nextPosition) {
            console.log("WARNING: Iterator exists but nextPosition is null. Track type:", placed.element.trackType);
            if (typeof iterator.next === "function") {
                iterator.next();
                if (!iterator.nextPosition) throw new Error("Track has no valid next position");
            } else {
                throw new Error("Track has no next position available");
            }
        }

        const nextTileX = Math.round(iterator.nextPosition.x / 32);
        const nextTileY = Math.round(iterator.nextPosition.y / 32);
        const nextTileZ = iterator.nextPosition.z / 8;
        const nextDirection = iterator.nextPosition.direction;

        // Initialize state if missing (e.g. ride created outside our flow).
        let state = rideTrackStates.get(params.ride);
        if (!state) {
            state = { history: [] };
            rideTrackStates.set(params.ride, state);
        }
        // Record first piece's start position once, for circuit detection.
        if (!state.firstPiece) {
            state.firstPiece = {
                x: params.tileCoordinateX,
                y: params.tileCoordinateY,
                z: params.tileCoordinateZ,
                direction: params.direction,
            };
        }

        const isCircuitComplete = (
            state.firstPiece
            && nextTileX === state.firstPiece.x
            && nextTileY === state.firstPiece.y
            && nextTileZ === state.firstPiece.z
            && nextDirection === state.firstPiece.direction
        );

        if (isCircuitComplete) {
            console.log("CIRCUIT COMPLETE! Track successfully connects back to start.");
        }

        state.history.push({
            x: params.tileCoordinateX,
            y: params.tileCoordinateY,
            z: params.tileCoordinateZ,
            direction: params.direction,
            trackType: params.trackType,
            nextX: nextTileX,
            nextY: nextTileY,
            nextZ: nextTileZ,
            nextDirection,
            elementIndex: placed.elementIndex,
            placedTileX: placed.tileX,
            placedTileY: placed.tileY,
        });
        state.isComplete = isCircuitComplete;

        const responsePayload = {
            message: `Track piece placed for ride ${params.ride}`,
            nextEndpoint: { x: nextTileX, y: nextTileY, z: nextTileZ, direction: nextDirection },
            isCircuitComplete,
            circuitMessage: isCircuitComplete
                ? "Circuit complete! Track connects back to start - ready for testing!"
                : "Continue building...",
            debug: {
                placedAt: { x: placed.tileX, y: placed.tileY, z: result.position.z },
                trackType: params.trackType,
                elemDirection: placed.element.direction,
            },
        };
        if (isStationPiece) responsePayload.stationDetected = true;
        return responsePayload;
    }
```

**Step 3: Replace the switch case**

```js
            case "placeTrackPiece":
                runHandler(handlePlaceTrackPiece(request.params), callback);
                break;
```

**Step 4: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 5: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert placeTrackPiece to async handler & fix circuit detection

Replaces the nested-callback pyramid with a linear async flow.

Behavior change: isCircuitComplete now compares nextEndpoint against
the first placed piece's start position (recorded in state.firstPiece),
instead of the hard-coded (61, 66, 14, dir=0). Field name and shape
are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Convert `placeEntranceExit` to async handler

The biggest cleanup. ~180 lines of attempt-counting state-machine callbacks → ~50 lines of async loop.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Add the station-piece search helper**

```js
    function findStationPieces(rideId) {
        const stationPieces = [];
        for (let x = 0; x < map.size.x; x++) {
            for (let y = 0; y < map.size.y; y++) {
                const tile = map.getTile(x, y);
                if (!tile) continue;
                for (let i = 0; i < tile.numElements; i++) {
                    const elem = tile.elements[i];
                    if (elem.type === "track" && elem.ride === rideId
                        && (elem.trackType === 1 || elem.trackType === 2 || elem.trackType === 3)) {
                        stationPieces.push({
                            x, y,
                            z: elem.baseZ,
                            direction: elem.direction,
                            trackType: elem.trackType,
                        });
                        console.log(`Found station piece at ${x} ${y} direction: ${elem.direction} type: ${elem.trackType}`);
                    }
                }
            }
        }
        return stationPieces;
    }
```

**Step 2: Add the entrance/exit position helper**

```js
    function entranceExitPositionsFor(stationTile) {
        const dir = stationTile.direction;
        if (dir === 0 || dir === 2) {
            // Track runs east-west, place perpendicular north-south
            return {
                entrance: { x: stationTile.x, y: stationTile.y - 1, direction: 3 },
                exit:     { x: stationTile.x, y: stationTile.y + 1, direction: 1 },
            };
        }
        // Track runs north-south, place perpendicular east-west
        return {
            entrance: { x: stationTile.x - 1, y: stationTile.y, direction: 2 },
            exit:     { x: stationTile.x + 1, y: stationTile.y, direction: 0 },
        };
    }
```

**Step 3: Add the place-attempt helper**

```js
    async function tryPlaceEntranceOrExit(rideId, position, isExit) {
        try {
            await executeAction("rideentranceexitplace", {
                x: position.x * 32,
                y: position.y * 32,
                direction: position.direction,
                ride: rideId,
                station: 0,
                isExit,
            });
            console.log(`Successfully placed ${isExit ? "exit" : "entrance"} at ${position.x} ${position.y}`);
            return { x: position.x, y: position.y, direction: position.direction };
        } catch (e) {
            console.log(`Failed to place ${isExit ? "exit" : "entrance"} at ${position.x} ${position.y}: ${e.message}`);
            return null;
        }
    }
```

**Step 4: Add the endpoint handler**

```js
    async function handlePlaceEntranceExit(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");

        const ride = [...map.rides].find(r => r.id === rideId);
        if (!ride) throw new Error(`Ride ${rideId} not found`);

        const stationPieces = findStationPieces(rideId);
        if (stationPieces.length === 0) throw new Error(`No station pieces found for ride ${rideId}`);
        console.log(`Found ${stationPieces.length} station pieces total`);

        let entrance = null, exit = null;
        for (let i = 0; i < stationPieces.length; i++) {
            const positions = entranceExitPositionsFor(stationPieces[i]);
            if (!entrance) entrance = await tryPlaceEntranceOrExit(rideId, positions.entrance, false);
            if (!exit)     exit     = await tryPlaceEntranceOrExit(rideId, positions.exit, true);
            if (entrance && exit) break;
        }

        if (entrance && exit) {
            return { entrance, exit, message: "Successfully placed entrance and exit" };
        }
        if (entrance || exit) {
            return {
                entrance, exit,
                warning: "Only partially successful - "
                    + (!entrance ? "Could not place entrance. " : "")
                    + (!exit ? "Could not place exit." : ""),
            };
        }
        throw new Error("Failed to place entrance and exit. No valid positions found near any station piece.");
    }
```

**Step 5: Replace the switch case**

```js
            case "placeEntranceExit":
                runHandler(handlePlaceEntranceExit(request.params), callback);
                break;
```

**Step 6: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 7: Commit**

```bash
git add ridecreation-api.js
git commit -m "convert placeEntranceExit to async handler

Replaces ~180 lines of attempt-counting callback orchestration with a
sequential for loop and three helper functions. Also drops the manual
'find method not available' iteration in favor of Array.prototype.find.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Replace switch dispatcher with Map<endpoint, handler>

Now that every endpoint is an async handler, the switch becomes redundant — replace it with a single lookup.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Build the endpoints map**

Add inside `main()`, after all handlers are defined and before `processRequest`:

```js
    const endpoints = new Map([
        ["listAllRides",         () => handleListAllRides()],
        ["getAllTrackSegments",  () => handleGetAllTrackSegments()],
        ["deleteAllRides",       () => handleDeleteAllRides()],
        ["startRideTest",        params => handleStartRideTest(params)],
        ["getRideStats",         params => handleGetRideStats(params)],
        ["placeTrackPiece",      params => handlePlaceTrackPiece(params)],
        ["getValidNextPieces",   params => handleGetValidNextPieces(params)],
        ["placeEntranceExit",    params => handlePlaceEntranceExit(params)],
        ["deleteLastTrackPiece", params => handleDeleteLastTrackPiece(params)],
        ["createRide",           params => handleCreateRide(params)],
    ]);
```

**Step 2: Replace `processRequest`**

Replace the entire `processRequest` function with:

```js
    function processRequest(request, callback) {
        if (!request.endpoint) {
            callback({ success: false, error: "Missing endpoint" });
            return;
        }
        const handler = endpoints.get(request.endpoint);
        if (!handler) {
            callback({ success: false, error: `Unknown endpoint: ${request.endpoint}` });
            return;
        }
        runHandler(handler(request.params), callback);
    }
```

**Step 3: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 4: Sanity check — line count**

Run: `wc -l ridecreation-api.js`
Expected: substantially smaller than the original 1019 lines (probably 600–700).

**Step 5: Commit**

```bash
git add ridecreation-api.js
git commit -m "replace switch dispatcher with endpoints Map

Each handler is now a single line of registration. Adds an explicit
'Unknown endpoint' error response that the old switch silently dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Modernize remaining syntax in `main()` and connection handler

The connection handler (lines 19–58 originally), main() preamble, and `getTrackStateCategory` are still ES5. Sweep them.

**Files:**
- Modify: `ridecreation-api.js`

**Step 1: Modernize the top of `main()`**

Convert config block:
```js
    const RANDOM_PORT = false;
    const RANDOM_PORT_MIN = 20000;
    const RANDOM_PORT_MAX = 30000;

    let port = 8080;
    if (RANDOM_PORT) {
        port = Math.floor(Math.random() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1)) + RANDOM_PORT_MIN;
        console.log(`Random port mode enabled - selected port ${port}`);
    }
```

**Step 2: Modernize the connection handler**

Replace the IIFE-based message loop with arrow functions and modern syntax:
```js
    const server = network.createListener();
    server.on("connection", conn => {
        let buffer = "";
        conn.on("data", data => {
            buffer += data;
            const lines = buffer.split("\n");
            if (lines[lines.length - 1] !== "") {
                buffer = lines.pop();
            } else {
                buffer = "";
                lines.pop();
            }
            for (const line of lines) {
                let request;
                try {
                    request = JSON.parse(line);
                } catch (e) {
                    conn.write(JSON.stringify({ success: false, error: "Invalid JSON" }) + "\n");
                    continue;
                }
                processRequest(request, response => {
                    conn.write(JSON.stringify(response) + "\n");
                });
            }
        });
    });

    server.listen(port);
    console.log(`Ride API server listening on port ${port}.`);
```

**Step 3: Modernize `getTrackStateCategory`**

Convert all internal `var`s, leave the switch shape intact (it's a value lookup; switch is fine). Change the warning log to a template literal.

**Step 4: Modernize `trackConnectionRules` and remaining `var`s**

Run:
```bash
grep -n "^[[:space:]]*var " ridecreation-api.js
```
Replace each remaining `var` with `const` (or `let` if it's reassigned). Replace any `+`-based string concatenation in console.logs with template literals.

**Step 5: Syntax check**

Run: `node --check ridecreation-api.js`
Expected: no output.

**Step 6: Commit**

```bash
git add ridecreation-api.js
git commit -m "modernize remaining var/let/concatenation in main and dispatcher

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: User-runs-it integration test

This task is for the user, not Claude. After Task 16 is committed, hand the work back.

**Step 1: User loads plugin into OpenRCT2 0.5.0**

Copy `ridecreation-api.js` into the OpenRCT2 plugins folder. Start OpenRCT2 with the developer console enabled.

**Step 2: User confirms server starts**

Expected console output: `Ride API server listening on port 8080.` (or random port if `RANDOM_PORT` is set).

**Step 3: User runs the existing test scripts**

```bash
python3 test_validation.py
python3 test_entrance_exit.py
./test_station.sh
```

**Step 4: Iterate on any failures**

If any test fails, paste the output back to Claude. We'll diagnose: (1) was a behavior change introduced unintentionally? (2) is there a quickjs-ng feature that doesn't work the way we expected? (3) is the new circuit-detection logic firing differently than the test expects?

**Step 5: Tag the release**

Once all tests pass:
```bash
git tag -a v0.2 -m "OpenRCT2 0.5.0 / quickjs-ng support"
```

---

## Reference: skill links

- @superpowers:executing-plans — task-by-task execution with review checkpoints
- @superpowers:subagent-driven-development — dispatched subagent per task with code review
- @superpowers:verification-before-completion — required before claiming any task is done
