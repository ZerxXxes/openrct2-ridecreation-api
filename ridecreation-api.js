function main() {
    "use strict";

    // Configuration flags - Edit these to change behavior
    const RANDOM_PORT = false;  // Set to true to use a random port instead of 8080
    const RANDOM_PORT_MIN = 20000;  // Minimum port when using random selection
    const RANDOM_PORT_MAX = 30000;  // Maximum port when using random selection

    // Select port based on configuration
    let port = 8080;
    if (RANDOM_PORT) {
        port = Math.floor(Math.random() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1)) + RANDOM_PORT_MIN;
        console.log(`Random port mode enabled - selected port ${port}`);
    }

    // Create TCP listener
    const server = network.createListener();

    server.on("connection", conn => {
        let buffer = "";

        // Handle incoming data on this connection.
        conn.on("data", data => {
            buffer += data;
            // Split messages on newline; we assume one JSON blob per line.
            const lines = buffer.split("\n");
            // If the last element is not empty, it means the last line is incomplete.
            if (lines[lines.length - 1] !== "") {
                buffer = lines.pop();
            } else {
                // All lines complete; clear the buffer.
                buffer = "";
                // Remove the empty string after the trailing newline.
                lines.pop();
            }

            // Process each complete JSON message.
            for (const line of lines) {
                let request;
                try {
                    request = JSON.parse(line);
                } catch (e) {
                    conn.write(JSON.stringify({
                        success: false,
                        error: "Invalid JSON"
                    }) + "\n");
                    continue;
                }

                processRequest(request, response => {
                    // Send the response as a JSON blob followed by a newline.
                    conn.write(JSON.stringify(response) + "\n");
                });
            }
        });
    });

    // Bind to the selected port
    server.listen(port);
    console.log(`Ride API server listening on port ${port}.`);

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

    // Run an async handler and convert its resolved value / thrown error
    // into the standard {success, payload|error} response shape.
    function runHandler(handlerPromise, callback) {
        handlerPromise
            .then(payload => callback({ success: true, payload }))
            .catch(e => callback({ success: false, error: e && e.message ? e.message : String(e) }));
    }

    // Track validation rules based on ending pitch and roll states
    // Based on actual TrackElemType enum from OpenRCT2 source and neural_rct constraints
    const trackConnectionRules = {
        // Station pieces - Begin/Middle station can only go to End/Middle station
        "station": {
            allowed: [1, 3] // EndStation, MiddleStation only
        },
        // End station has many valid transitions (based on neural_rct)
        "end_station": {
            allowed: [0, 6, 12, 16, 17, 18, 19, 42, 43] // flat, slope transitions, turns, banking starts
        },
        // Flat straight pieces (type 0)
        "flat": {
            allowed: [0, 6, 12, 16, 17, 42, 43, 4, 10, 18, 19] // flat, transitions, turns, banking transitions
        },
        // Gentle up slope (type 4 = Up25)
        "up25": {
            allowed: [4, 9, 7] // continue up25, up25-to-flat, up25-to-60
        },
        // Steep up slope (type 5 = Up60)
        "up60": {
            allowed: [5, 8] // continue up60 or transition down to up25
        },
        // Gentle down slope (type 10 = Down25)
        "down25": {
            allowed: [10, 15, 13] // continue down25, down25-to-flat, down25-to-60
        },
        // Steep down slope (type 11 = Down60)
        "down60": {
            allowed: [11, 14] // continue down60 or transition to down25
        },
        // Turns (16, 17, 42, 43)
        "turn": {
            allowed: [0, 16, 17, 42, 43, 6, 12, 18, 19] // flat, turns, gentle transitions, banking starts
        },
        // Banking pieces
        "left_bank": {
            allowed: [32, 20, 22, 44] // continue left bank, left-bank-to-flat, banked turns
        },
        "right_bank": {
            allowed: [33, 21, 23, 45] // continue right bank, right-bank-to-flat, banked turns
        },
        "flat_to_left_bank": {
            allowed: [32, 20, 22, 44] // left bank, left-bank-to-flat, banked left turns
        },
        "flat_to_right_bank": {
            allowed: [33, 21, 23, 45] // right bank, right-bank-to-flat, banked right turns
        }
    };

    // Track state storage (ride ID -> RideState)
    const rideTrackStates = new Map();

    /**
     * Get the track state category for validation rules
     * Based on actual TrackElemType values from OpenRCT2
     */
    function getTrackStateCategory(trackType, isStation) {
        // Map track types to state categories based on OpenRCT2 TrackElemType
        switch(trackType) {
            // Flat pieces
            case 0:  // Flat
                return "flat";
                
            // Station pieces - distinguish end station from begin/middle
            case 1:  // EndStation
                return "end_station";
            case 2:  // BeginStation
            case 3:  // MiddleStation
                return "station";
                
            // Up slopes
            case 4:  // Up25
                return "up25";
            case 5:  // Up60
                return "up60";
                
            // Down slopes
            case 10: // Down25
                return "down25";
            case 11: // Down60
                return "down60";
                
            // Transitions
            case 6:  // FlatToUp25 - ends at up25 angle
                return "up25"; // After this transition, we're at 25° up
            case 12: // FlatToDown25 - ends at down25 angle
                return "down25"; // After this transition, we're at 25° down
            case 9:  // Up25ToFlat
            case 15: // Down25ToFlat
                return "flat"; // These end flat
                
            case 7:  // Up25ToUp60 - ends in steep up
                return "up60"; // This ends in Up60, not Up25!
                
            case 8:  // Up60ToUp25 - ends in gentle up
                return "up25"; // This ends in Up25
                
            case 13: // Down25ToDown60 - ends in steep down
                return "down60"; // This ends in Down60, not Down25!
                
            case 14: // Down60ToDown25 - ends in gentle down
                return "down25"; // This ends in Down25
                
            // Turns
            case 16: // LeftQuarterTurn5Tiles
            case 17: // RightQuarterTurn5Tiles
            case 42: // LeftQuarterTurn3Tiles
            case 43: // RightQuarterTurn3Tiles
                return "turn";
                
            // Banking pieces
            case 18: // FlatToLeftBank
                return "flat_to_left_bank";
            case 19: // FlatToRightBank
                return "flat_to_right_bank";
            case 20: // LeftBankToFlat
            case 21: // RightBankToFlat
                return "flat"; // These end flat
            case 32: // LeftBank
                return "left_bank";
            case 33: // RightBank
                return "right_bank";
            case 22: // BankedLeftQuarterTurn5Tiles
            case 44: // LeftBankedQuarterTurn3Tiles
                return "left_bank"; // Banked left turns maintain left bank
            case 23: // BankedRightQuarterTurn5Tiles
            case 45: // RightBankedQuarterTurn3Tiles
                return "right_bank"; // Banked right turns maintain right bank
                
            default:
                console.log("Unknown track type:", trackType, "- defaulting to flat");
                return "flat"; // Default to flat for unknown pieces
        }
    }

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
        ["listLoadedRideObjects", () => handleListLoadedRideObjects()],
    ]);

    /**
     * Dispatches a JSON request to its endpoint handler.
     * Looks up endpoint by name in the `endpoints` Map and calls
     * the matching async handler. Resolved values become
     * {success: true, payload}; thrown errors become {success: false, error}.
     */
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

    async function handleListAllRides() {
        const ridesArray = [];
        map.rides.forEach(ride => {
            ridesArray.push({ id: ride.id, name: ride.name, type: ride.type });
        });
        return ridesArray;
    }

    async function handleListLoadedRideObjects() {
        const all = objectManager.getAllObjects("ride");
        return all.map(o => ({
            index: o.index,
            identifier: o.identifier,
            name: o.name,
            rideType: o.rideType,
        }));
    }

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

    async function handleStartRideTest(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");
        try {
            await executeAction("ridesetstatus", { ride: rideId, status: 2 });
        } catch (e) {
            throw new Error(`Failed to start ride test: ${e.message}`);
        }
        return `Ride ${rideId} started in test mode.`;
    }

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
                inspectionInterval: typeof params.inspectionInterval === "number" ? params.inspectionInterval : 2,
            });
        } catch (e) {
            throw new Error(`Failed to create ride: ${e.message}`);
        }
        if (typeof result.ride !== "number") throw new Error("Failed to create ride: no ride id returned");
        rideTrackStates.set(result.ride, { history: [] });
        console.log(`Initialized fresh track state for ride ${result.ride}`);
        return { rideId: result.ride };
    }

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
        if (state.history.length === 0) {
            state.firstPiece = null;
            state.isComplete = false;
        }
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

    // Search for the just-placed track element. First checks the central tile
    // with tolerance 8, then falls back to all 9 surrounding tiles (including
    // the center) with tolerance 16. Returns { tile, element, elementIndex,
    // tileX, tileY } or null.
    function findPlacedTrackElement(rideId, resultPosition) {
        const placedTileZ = resultPosition.z;
        const baseX = Math.floor(resultPosition.x / 32);
        const baseY = Math.floor(resultPosition.y / 32);

        const centerTile = map.getTile(baseX, baseY);
        if (centerTile) {
            for (let i = 0; i < centerTile.numElements; i++) {
                const elem = centerTile.elements[i];
                if (elem.type === "track" && elem.ride === rideId
                    && Math.abs(elem.baseZ - placedTileZ) <= 8) {
                    return { tile: centerTile, element: elem, elementIndex: i, tileX: baseX, tileY: baseY };
                }
            }
        }

        const offsets = [
            [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
            [-1, -1], [-1, 1], [1, -1], [1, 1],
        ];
        for (const [dx, dy] of offsets) {
            const tx = baseX + dx;
            const ty = baseY + dy;
            const tile = map.getTile(tx, ty);
            if (!tile) continue;
            for (let i = 0; i < tile.numElements; i++) {
                const elem = tile.elements[i];
                if (elem.type === "track" && elem.ride === rideId
                    && Math.abs(elem.baseZ - placedTileZ) <= 16) {
                    return { tile, element: elem, elementIndex: i, tileX: tx, tileY: ty };
                }
            }
        }
        return null;
    }

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

        const placedTileX = Math.floor(result.position.x / 32);
        const placedTileY = Math.floor(result.position.y / 32);
        if (!map.getTile(placedTileX, placedTileY)) {
            throw new Error("Tile not found at placed position");
        }

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
            console.log("CIRCUIT COMPLETE! Track successfully connects back to station.");
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
                ? "Circuit complete! Track connects back to station - ready for testing!"
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

    async function handlePlaceEntranceExit(params) {
        const { rideId } = params || {};
        if (typeof rideId !== "number") throw new Error("Missing or invalid parameter: rideId");

        if (!map.getRide(rideId)) throw new Error(`Ride ${rideId} not found`);

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
}

// Register the plugin
registerPlugin({
    name: "Ride Creation API Plugin",
    version: "0.2",
    authors: ["Markus"],
    type: "intransient",
    licence: "MIT",
    minApiVersion: 111,
    targetApiVersion: 111,
    main: main
});
