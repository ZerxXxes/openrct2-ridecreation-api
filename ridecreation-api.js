function main() {
    "use strict";

    // Create a TCP listener on port 8080
    var server = network.createListener();

    server.on("connection", function (conn) {
        var buffer = "";

        // Handle incoming data on this connection.
        conn.on("data", function (data) {
            buffer += data;
            // Split messages on newline; we assume one JSON blob per line.
            var lines = buffer.split("\n");
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
            for (var i = 0; i < lines.length; i++) {
                (function(line) {
                    var request;
                    try {
                        request = JSON.parse(line);
                    } catch (e) {
                        conn.write(JSON.stringify({
                            success: false,
                            error: "Invalid JSON"
                        }) + "\n");
                        return;
                    }

                    processRequest(request, function (response) {
                        // Send the response as a JSON blob followed by a newline.
                        conn.write(JSON.stringify(response) + "\n");
                    });
                })(lines[i]);
            }
        });
    });

    server.listen(8080);
    console.log("Ride API server listening on port 8080.");

    // Track validation rules based on ending pitch and roll states
    // Based on actual TrackElemType enum from OpenRCT2 source
    var trackConnectionRules = {
        // Station pieces (types 1, 2, 3) can only connect to flat or gentle up
        "station": {
            allowed: [0, 6, 4, 16, 17, 42, 43, 18, 19], // flat, flat-to-up25, up25 (with or without chain), turns, banking transitions
            forbidden: [10, 11, 12, 5, 32, 33] // down slopes, steep up, and banked pieces
            // Note: Up25 (4) and FlatToUp25 (6) are commonly used with chain lifts after stations
        },
        // Flat straight pieces (type 0)
        "flat": {
            allowed: [0, 6, 12, 16, 17, 42, 43, 1, 2, 3, 4, 10, 18, 19], // flat, transitions, turns, stations, banking transitions
            forbidden: [5, 11, 32, 33, 15, 9] // no direct steep, no direct banking, no ending transitions
        },
        // Gentle up slope (type 4 = Up25)
        "up25": {
            allowed: [4, 9, 7], // continue up25, up25-to-flat, up25-to-60
            forbidden: [10, 11, 12, 5, 6, 8] // no immediate down, direct steep, or up60-to-up25 (not coming from up60!)
        },
        // Steep up slope (type 5 = Up60)
        "up60": {
            allowed: [5, 8], // continue up60 or transition down to up25
            forbidden: [10, 11, 12, 0, 4, 6, 7] // no immediate down, flat, or up25-to-up60 (already steep!)
        },
        // Gentle down slope (type 10 = Down25)
        "down25": {
            allowed: [10, 15, 13], // continue down25, down25-to-flat, down25-to-60
            forbidden: [4, 5, 6, 11, 12, 14] // no immediate up, direct steep, or down60-to-down25 (not coming from down60!)
        },
        // Steep down slope (type 11 = Down60)
        "down60": {
            allowed: [11, 14], // continue down60 or transition to down25
            forbidden: [4, 5, 6, 0, 10, 12, 13] // no immediate up, flat, or down25-to-down60 (already steep!)
        },
        // Turns (16, 17, 42, 43)
        "turn": {
            allowed: [0, 16, 17, 42, 43, 6, 12], // flat, turns, gentle transitions
            forbidden: [5, 11] // no steep during turns
        },
        // Banking pieces
        "left_bank": {
            allowed: [32, 20, 22, 44], // continue left bank, left-bank-to-flat, banked turns
            forbidden: [33, 19, 5, 11] // no opposite bank or steep slopes
        },
        "right_bank": {
            allowed: [33, 21, 23, 45], // continue right bank, right-bank-to-flat, banked turns
            forbidden: [32, 18, 5, 11] // no opposite bank or steep slopes
        },
        "flat_to_left_bank": {
            allowed: [32, 22, 44], // left bank or banked left turns
            forbidden: [33, 23, 45] // no right banking
        },
        "flat_to_right_bank": {
            allowed: [33, 23, 45], // right bank or banked right turns
            forbidden: [32, 22, 44] // no left banking
        }
    };

    // Track state storage (ride ID -> state)
    var rideTrackStates = {};

    /**
     * Get the track state category for validation rules
     * Based on actual TrackElemType values from OpenRCT2
     */
    function getTrackStateCategory(trackType, isStation) {
        // Station pieces
        if (isStation || trackType === 1 || trackType === 2 || trackType === 3) {
            return "station";
        }
        
        // Map track types to state categories based on OpenRCT2 TrackElemType
        switch(trackType) {
            // Flat pieces
            case 0:  // Flat
                return "flat";
                
            // Station pieces
            case 1:  // EndStation
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

    /**
     * Processes a request object and calls the callback with the response.
     *
     * Supported endpoints include:
     * - listAllRides
     * - deleteAllRides
     * - startRideTest
     * - getRideStats
     * - createRide
     * - placeTrackPiece
     * - placeEntranceExit (place entrance and exit for a ride's station)
     * - deleteLastTrackPiece (remove the most recently placed track piece)
     * - getValidNextPieces (new endpoint for track validation)
     * - getTrackCircuit (new endpoint that takes a rideId)
     *
     * @param {Object} request - The parsed JSON request.
     * @param {Function} callback - The function to call with the response.
     */
    function processRequest(request, callback) {
        if (!request.endpoint) {
            callback({
                success: false,
                error: "Missing endpoint"
            });
            return;
        }

        switch (request.endpoint) {
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
            
            case "getAllTrackSegments":
                // Retrieve all available track segments.
                var segments = context.getAllTrackSegments();
                var result = segments.map(function(seg) {
                    return {
                        type: seg.type,
                        description: seg.description,
                        trackGroup: seg.trackGroup,
                        length: seg.length,
                        // Add more properties to understand track types
                        beginZ: seg.beginZ,
                        endZ: seg.endZ,
                        beginDirection: seg.beginDirection,
                        endDirection: seg.endDirection,
                        beginBank: seg.beginBank,
                        endBank: seg.endBank
                    };
                });
                callback({
                    success: true,
                    payload: result
                });
                break;

            case "deleteAllRides":
                var ridesToDelete = [];
                map.rides.forEach(function (ride) {
                    ridesToDelete.push(ride);
                });
                if (ridesToDelete.length === 0) {
                    callback({
                        success: true,
                        payload: "No rides to delete."
                    });
                    return;
                }
                function deleteNext() {
                    if (ridesToDelete.length === 0) {
                        callback({
                            success: true,
                            payload: "Deleted all rides."
                        });
                        return;
                    }
                    var ride = ridesToDelete.shift();
                    context.executeAction("ridedemolish", {
                        ride: ride.id,
                        modifyType: 0  // 0 means demolish.
                    }, function (result) {
                        if (!result || (result.error && result.error !== "")) {
                            console.log("Error demolishing ride " + ride.id + ": " + (result && result.error ? result.error : "Unknown error"));
                        } else {
                            // Clear the ride state when ride is deleted
                            delete rideTrackStates[ride.id];
                            console.log("Cleared track state for deleted ride " + ride.id);
                        }
                        deleteNext();
                    });
                }
                deleteNext();
                break;

            case "startRideTest":
                if (!request.params || typeof request.params.rideId !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameter: rideId"
                    });
                    return;
                }
                var rideId = request.params.rideId;
                context.executeAction("ridesetstatus", {
                    ride: rideId,
                    status: 2 // 2 means testing.
                }, function (result) {
                    if (!result || (result.error && result.error !== "")) {
                        callback({
                            success: false,
                            error: "Failed to start ride test: " + (result && result.error ? result.error : "Unknown error")
                        });
                    } else {
                        callback({
                            success: true,
                            payload: "Ride " + rideId + " started in test mode."
                        });
                    }
                });
                break;

            case "getRideStats":
                if (!request.params || typeof request.params.rideId !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameter: rideId"
                    });
                    return;
                }
                var rideId = request.params.rideId;
                var ride = map.getRide(rideId);
                if (!ride) {
                    callback({
                        success: false,
                        error: "Ride not found"
                    });
                    return;
                }
                var stats = {
                    excitement: ride.excitement / 100,
                    intensity: ride.intensity / 100,
                    nausea: ride.nausea / 100
                };
                callback({
                    success: true,
                    payload: stats
                });
                break;

            case "placeTrackPiece":
                // Required parameters:
                // tileCoordinateX, tileCoordinateY, tileCoordinateZ, direction, ride,
                // trackType, rideType, brakeSpeed, colour, seatRotation, trackPlaceFlags, isFromTrackDesign
                // Optional: hasChainLift (boolean) - adds chain lift to slope pieces
                var requiredParams = [
                    "tileCoordinateX", "tileCoordinateY", "tileCoordinateZ", "direction", "ride",
                    "trackType", "rideType", "brakeSpeed", "colour",
                    "seatRotation", "trackPlaceFlags", "isFromTrackDesign"
                ];
                if (!request.params) {
                    callback({ success: false, error: "Missing parameters for placeTrackPiece" });
                    return;
                }
                for (var i = 0; i < requiredParams.length; i++) {
                    var key = requiredParams[i];
                    if (typeof request.params[key] === "undefined") {
                        callback({ success: false, error: "Missing parameter: " + key });
                        return;
                    }
                }
                // Convert tile-based input coordinates to game (pixel) units.
                var pixelCoordinateX = request.params.tileCoordinateX * 32;
                var pixelCoordinateY = request.params.tileCoordinateY * 32;
                var pixelCoordinateZ = request.params.tileCoordinateZ * 8;
                // Check if chain lift flag should be added
                var flags = request.params.trackPlaceFlags;
                if (request.params.hasChainLift === true) {
                    // Add chain lift flag (bit 0)
                    flags = flags | 1;
                }
                
                // Log station piece placement for debugging
                // Station types: 1=EndStation, 2=BeginStation, 3=MiddleStation
                var isStationPiece = (request.params.trackType === 1 || 
                                     request.params.trackType === 2 || 
                                     request.params.trackType === 3);
                
                if (isStationPiece) {
                    console.log("Station piece placed - Type:", request.params.trackType, "for ride", request.params.ride);
                    console.log("Note: Use placeEntranceExit endpoint to add entrance/exit after station is complete");
                }
                
                var trackPlaceArgs = {
                    x: pixelCoordinateX,
                    y: pixelCoordinateY,
                    z: pixelCoordinateZ,
                    direction: request.params.direction,
                    ride: request.params.ride,
                    trackType: request.params.trackType,
                    rideType: request.params.rideType,
                    brakeSpeed: request.params.brakeSpeed,
                    colour: request.params.colour,
                    seatRotation: request.params.seatRotation,
                    trackPlaceFlags: flags,
                    isFromTrackDesign: request.params.isFromTrackDesign
                };
                context.executeAction("trackplace", trackPlaceArgs, function(result) {
                    if (!result || (result.error && result.error !== "")) {
                        callback({
                            success: false,
                            error: "Failed to place track piece: " +
                                (result && result.error ? result.error : "Unknown error")
                        });
                    } else {
                        console.log("Track placed successfully at result position:", result.position);
                        
                        // Get the tile where the track was actually placed (using result position)
                        var placedTileX = Math.floor(result.position.x / 32);
                        var placedTileY = Math.floor(result.position.y / 32);
                        var placedTileZ = result.position.z;
                        
                        console.log("Looking for track on tile:", placedTileX, placedTileY, "at height:", placedTileZ);
                        
                        var tile = map.getTile(placedTileX, placedTileY);
                        if (!tile) {
                            callback({ success: false, error: "Tile not found at placed position" });
                            return;
                        }
                        
                        // Find the track element that was just placed
                        var elem_index = -1;
                        var targetRide = request.params.ride;
                        var trackElement = null;
                        
                        console.log("Searching for track element for ride:", targetRide);
                        for (var i = 0; i < tile.numElements; i++) {
                            var elem = tile.elements[i];
                            if (elem.type === 'track' && elem.ride === targetRide) {
                                console.log("Found track element at index", i, "with baseZ:", elem.baseZ, "vs placedZ:", placedTileZ);
                                // Check if this element is at the right height (with some tolerance)
                                if (Math.abs(elem.baseZ - placedTileZ) <= 8) {
                                    elem_index = i;
                                    trackElement = elem;
                                    break;
                                }
                            }
                        }
                        
                        if (elem_index === -1) {
                            console.log("ERROR: Could not find track element on tile. Checking all tiles around...");
                            
                            // Try to find the track element on neighboring tiles
                            var searchOffsets = [
                                [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
                                [-1, -1], [-1, 1], [1, -1], [1, 1]
                            ];
                            
                            for (var j = 0; j < searchOffsets.length; j++) {
                                var searchX = placedTileX + searchOffsets[j][0];
                                var searchY = placedTileY + searchOffsets[j][1];
                                var searchTile = map.getTile(searchX, searchY);
                                
                                if (searchTile) {
                                    for (var k = 0; k < searchTile.numElements; k++) {
                                        var searchElem = searchTile.elements[k];
                                        if (searchElem.type === 'track' && searchElem.ride === targetRide) {
                                            if (Math.abs(searchElem.baseZ - placedTileZ) <= 16) {
                                                console.log("Found track on neighboring tile at offset", searchOffsets[j], "tile:", searchX, searchY);
                                                placedTileX = searchX;
                                                placedTileY = searchY;
                                                tile = searchTile;
                                                elem_index = k;
                                                trackElement = searchElem;
                                                break;
                                            }
                                        }
                                    }
                                    if (elem_index !== -1) break;
                                }
                            }
                            
                            if (elem_index === -1) {
                                callback({ success: false, error: "Could not find track element on any nearby tile" });
                                return;
                            }
                        }
                        
                        console.log("Found track element at index:", elem_index, "on tile:", placedTileX, placedTileY);
                        console.log("Track element details - direction:", trackElement.direction, "trackType:", trackElement.trackType);
                        
                        // Create track iterator at the track element's position
                        var iteratorPos = { x: placedTileX * 32, y: placedTileY * 32 };
                        var iterator = map.getTrackIterator(iteratorPos, elem_index);
                        
                        if (!iterator) {
                            console.log("ERROR: Could not create track iterator at position:", iteratorPos, "index:", elem_index);
                            callback({ success: false, error: "Track iterator not available" });
                            return;
                        }
                        
                        if (!iterator.nextPosition) {
                            console.log("WARNING: Iterator exists but nextPosition is null. Track type:", trackElement.trackType);
                            console.log("Iterator details:", JSON.stringify({
                                position: iterator.position,
                                previousPosition: iterator.previousPosition,
                                segment: iterator.segment
                            }));
                            
                            // For some track pieces, we might need to advance the iterator
                            if (iterator.next && typeof iterator.next === 'function') {
                                var advanced = iterator.next();
                                if (advanced && iterator.nextPosition) {
                                    console.log("Advanced iterator, now have nextPosition:", iterator.nextPosition);
                                } else {
                                    callback({ success: false, error: "Track has no valid next position" });
                                    return;
                                }
                            } else {
                                callback({ success: false, error: "Track has no next position available" });
                                return;
                            }
                        }
                        
                        console.log("Iterator nextPosition (game coords):", iterator.nextPosition);
                        
                        // The iterator's nextPosition seems to point to the tile center (16 pixels from corner)
                        // We need the tile coordinates for placement
                        // Simply round to nearest tile
                        var nextTileX = Math.round(iterator.nextPosition.x / 32);
                        var nextTileY = Math.round(iterator.nextPosition.y / 32);
                        var nextTileZ = iterator.nextPosition.z / 8;
                        var nextDirection = iterator.nextPosition.direction;
                        
                        console.log("Converted to tile coords - X:", nextTileX, "Y:", nextTileY, "Z:", nextTileZ, "Dir:", nextDirection);
                        
                        // Check if circuit is complete
                        // We start stations at (67, 66, 14) and place 6 station pieces going left (direction 0 = west)
                        // So the track needs to return to (61, 66, 14) with direction 0 to connect to the last station piece
                        var startStationX = 61; // After 6 station pieces from 67 to 62
                        var startStationY = 66;
                        var startStationZ = 14;
                        var startDirection = 0;
                        
                        var isCircuitComplete = (
                            nextTileX === startStationX &&
                            nextTileY === startStationY &&
                            nextTileZ === startStationZ &&
                            nextDirection === startDirection
                        );
                        
                        var circuitMessage = isCircuitComplete ? 
                            "Circuit complete! Track connects back to station - ready for testing!" : 
                            "Continue building...";
                        
                        if (isCircuitComplete) {
                            console.log("CIRCUIT COMPLETE! Track successfully connects back to station.");
                        }
                        
                        // Update ride track state for validation and history
                        rideTrackStates[request.params.ride] = rideTrackStates[request.params.ride] || { history: [] };
                        
                        // Add this piece to history for undo functionality
                        rideTrackStates[request.params.ride].history.push({
                            // Position where this piece was placed
                            x: request.params.tileCoordinateX,
                            y: request.params.tileCoordinateY,
                            z: request.params.tileCoordinateZ,
                            direction: request.params.direction,
                            trackType: request.params.trackType,
                            // Position where the next piece can connect (for restoring state after undo)
                            nextX: nextTileX,
                            nextY: nextTileY,
                            nextZ: nextTileZ,
                            nextDirection: nextDirection,
                            // Element index for removal
                            elementIndex: elem_index,
                            placedTileX: placedTileX,
                            placedTileY: placedTileY
                        });
                        
                        rideTrackStates[request.params.ride].isComplete = isCircuitComplete;
                        
                        var responsePayload = {
                            message: "Track piece placed for ride " + request.params.ride,
                            nextEndpoint: {
                                x: nextTileX,
                                y: nextTileY,
                                z: nextTileZ,
                                direction: nextDirection
                            },
                            isCircuitComplete: isCircuitComplete,
                            circuitMessage: circuitMessage,
                            debug: {
                                placedAt: { x: placedTileX, y: placedTileY, z: placedTileZ },
                                trackType: request.params.trackType,
                                elemDirection: trackElement.direction
                            }
                        };
                        
                        // Add station detection to response if applicable
                        if (isStationPiece) {
                            responsePayload.stationDetected = true;
                        }
                        
                        callback({ success: true, payload: responsePayload });
                    }
                });
                break;

            case "getValidNextPieces":
                if (!request.params || typeof request.params.rideId !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameter: rideId"
                    });
                    return;
                }
                
                var rideId = request.params.rideId;
                var state = rideTrackStates[rideId];
                
                if (!state || !state.history || state.history.length === 0) {
                    // No track placed yet or unknown state - allow only station and flat pieces to start
                    callback({
                        success: true,
                        payload: {
                            validPieces: [0, 1, 2, 3], // Only flat and station pieces to start
                            lastTrackType: null,
                            stateCategory: "initial"
                        }
                    });
                    return;
                }
                
                // Get the last placed track piece from history
                var lastPiece = state.history[state.history.length - 1];
                
                // Get the state category for the last placed track
                var stateCategory = getTrackStateCategory(lastPiece.trackType, false);
                var rules = trackConnectionRules[stateCategory];
                
                if (!rules) {
                    // No specific rules - allow safe flat pieces only
                    console.log("Warning: No rules for state category:", stateCategory, "track type:", lastPiece.trackType);
                    callback({
                        success: true,
                        payload: {
                            validPieces: [0, 16, 17, 42, 43], // Only flat and turns as safe fallback
                            lastTrackType: lastPiece.trackType,
                            stateCategory: stateCategory,
                            position: {
                                x: lastPiece.nextX,
                                y: lastPiece.nextY,
                                z: lastPiece.nextZ,
                                direction: lastPiece.nextDirection
                            }
                        }
                    });
                    return;
                }
                
                // Filter allowed pieces that are not in forbidden list
                var validPieces = rules.allowed.filter(function(piece) {
                    return rules.forbidden.indexOf(piece) === -1;
                });
                
                callback({
                    success: true,
                    payload: {
                        validPieces: validPieces,
                        lastTrackType: lastPiece.trackType,
                        stateCategory: stateCategory,
                        position: {
                            x: lastPiece.nextX,
                            y: lastPiece.nextY,
                            z: lastPiece.nextZ,
                            direction: lastPiece.nextDirection
                        }
                    }
                });
                break;

            case "placeEntranceExit":
                // Place entrance and exit for a ride's station
                if (!request.params || typeof request.params.rideId !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameter: rideId"
                    });
                    return;
                }
                
                var rideId = request.params.rideId;
                var ride = null;
                
                // Find the ride by iterating through all rides (find method not available)
                map.rides.forEach(function(r) {
                    if (r.id === rideId) {
                        ride = r;
                    }
                });
                
                if (!ride) {
                    callback({
                        success: false,
                        error: "Ride " + rideId + " not found"
                    });
                    return;
                }
                
                // Find the first station piece in the ride
                var stationTile = null;
                var stationDirection = null;
                var searchComplete = false;
                
                // Search for station pieces on the map
                for (var x = 0; x < map.size.x && !searchComplete; x++) {
                    for (var y = 0; y < map.size.y && !searchComplete; y++) {
                        var tile = map.getTile(x, y);
                        if (tile) {
                            for (var i = 0; i < tile.numElements; i++) {
                                var elem = tile.elements[i];
                                if (elem.type === 'track' && elem.ride === rideId) {
                                    // Check if this is a station piece (types 1, 2, or 3)
                                    if (elem.trackType === 1 || elem.trackType === 2 || elem.trackType === 3) {
                                        stationTile = { x: x, y: y, z: elem.baseZ };
                                        stationDirection = elem.direction;
                                        searchComplete = true;
                                        console.log("Found station piece at", x, y, "direction:", stationDirection);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                
                if (!stationTile) {
                    callback({
                        success: false,
                        error: "No station pieces found for ride " + rideId
                    });
                    return;
                }
                
                // Calculate positions for entrance and exit based on station direction
                // Direction: 0=west, 1=north, 2=east, 3=south
                var entranceX, entranceY, exitX, exitY;
                var entranceDir, exitDir;
                
                // Place entrance and exit perpendicular to track direction
                if (stationDirection === 0 || stationDirection === 2) {
                    // Track runs east-west, place entrance/exit north-south
                    entranceX = stationTile.x;
                    entranceY = stationTile.y - 1; // North of station
                    exitX = stationTile.x;
                    exitY = stationTile.y + 1; // South of station
                    entranceDir = 3; // Face south (towards station)
                    exitDir = 1; // Face north (away from station)
                } else {
                    // Track runs north-south, place entrance/exit east-west
                    entranceX = stationTile.x - 1; // West of station
                    entranceY = stationTile.y;
                    exitX = stationTile.x + 1; // East of station
                    exitY = stationTile.y;
                    entranceDir = 2; // Face east (towards station)
                    exitDir = 0; // Face west (away from station)
                }
                
                var entranceSuccess = false;
                var exitSuccess = false;
                var entranceError = null;
                var exitError = null;
                var actionsCompleted = 0;
                
                // Function to send response after both actions complete
                function checkAndSendResponse() {
                    actionsCompleted++;
                    if (actionsCompleted === 2) {
                        // Both actions completed, send response
                        if (entranceSuccess && exitSuccess) {
                            callback({
                                success: true,
                                payload: {
                                    entrance: { x: entranceX, y: entranceY, direction: entranceDir },
                                    exit: { x: exitX, y: exitY, direction: exitDir }
                                }
                            });
                        } else if (entranceSuccess || exitSuccess) {
                            callback({
                                success: true,
                                payload: {
                                    entrance: entranceSuccess ? { x: entranceX, y: entranceY, direction: entranceDir } : null,
                                    exit: exitSuccess ? { x: exitX, y: exitY, direction: exitDir } : null,
                                    warning: "Only partially successful - " + 
                                            (entranceError ? "Entrance: " + entranceError + " " : "") +
                                            (exitError ? "Exit: " + exitError : "")
                                }
                            });
                        } else {
                            callback({
                                success: false,
                                error: "Failed to place entrance and exit. Entrance: " + entranceError + ", Exit: " + exitError
                            });
                        }
                    }
                }
                
                // Place entrance
                context.executeAction("rideentranceexitplace", {
                    x: entranceX * 32,
                    y: entranceY * 32,
                    direction: entranceDir,
                    ride: rideId,
                    station: 0, // First station
                    isExit: false
                }, function(entranceResult) {
                    if (entranceResult && !entranceResult.error) {
                        console.log("Successfully placed entrance at", entranceX, entranceY);
                        entranceSuccess = true;
                    } else {
                        entranceError = entranceResult ? entranceResult.error : "Unknown error";
                        console.log("Failed to place entrance:", entranceError);
                    }
                    checkAndSendResponse();
                });
                
                // Place exit
                context.executeAction("rideentranceexitplace", {
                    x: exitX * 32,
                    y: exitY * 32,
                    direction: exitDir,
                    ride: rideId,
                    station: 0, // First station
                    isExit: true
                }, function(exitResult) {
                    if (exitResult && !exitResult.error) {
                        console.log("Successfully placed exit at", exitX, exitY);
                        exitSuccess = true;
                    } else {
                        exitError = exitResult ? exitResult.error : "Unknown error";
                        console.log("Failed to place exit:", exitError);
                    }
                    checkAndSendResponse();
                });
                break;

            case "deleteLastTrackPiece":
                // This endpoint only removes track pieces, not entrances/exits
                // Entrances/exits must be managed separately
                if (!request.params || typeof request.params.rideId !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameter: rideId"
                    });
                    return;
                }
                
                var rideId = request.params.rideId;
                var state = rideTrackStates[rideId];
                
                if (!state || !state.history || state.history.length === 0) {
                    callback({
                        success: false,
                        error: "No track pieces to delete for ride " + rideId
                    });
                    return;
                }
                
                // Get the last placed piece
                var lastPiece = state.history[state.history.length - 1];
                
                console.log("Attempting to remove track piece at tile:", lastPiece.placedTileX, lastPiece.placedTileY, 
                            "element index:", lastPiece.elementIndex, "trackType:", lastPiece.trackType);
                
                // Use trackremove action to delete the track piece
                context.executeAction("trackremove", {
                    x: lastPiece.placedTileX * 32,  // Convert tile to pixel coordinates
                    y: lastPiece.placedTileY * 32,
                    z: lastPiece.z * 8,  // Convert height units to pixel coordinates
                    direction: lastPiece.direction,
                    trackType: lastPiece.trackType,
                    sequence: 0  // Sequence number for multi-tile pieces (0 for single tile)
                }, function(result) {
                    if (!result || (result.error && result.error !== "")) {
                        console.log("Failed to remove track piece:", result ? result.error : "Unknown error");
                        callback({
                            success: false,
                            error: "Failed to remove track piece: " + (result && result.error ? result.error : "Unknown error")
                        });
                    } else {
                        console.log("Successfully removed track piece");
                        
                        // Remove the piece from history
                        state.history.pop();
                        
                        // Prepare response with the new current position
                        var responsePayload = {
                            message: "Track piece removed from ride " + rideId,
                            piecesRemaining: state.history.length
                        };
                        
                        // If there are still pieces, provide the new endpoint for building
                        if (state.history.length > 0) {
                            var newLastPiece = state.history[state.history.length - 1];
                            responsePayload.nextEndpoint = {
                                x: newLastPiece.nextX,
                                y: newLastPiece.nextY,
                                z: newLastPiece.nextZ,
                                direction: newLastPiece.nextDirection
                            };
                            responsePayload.lastTrackType = newLastPiece.trackType;
                        } else {
                            // No pieces left, ready to start fresh
                            responsePayload.nextEndpoint = null;
                            responsePayload.lastTrackType = null;
                        }
                        
                        callback({
                            success: true,
                            payload: responsePayload
                        });
                    }
                });
                break;

            case "createRide":
                if (!request.params ||
                    typeof request.params.rideType !== "number" ||
                    typeof request.params.rideObject !== "number" ||
                    typeof request.params.entranceObject !== "number" ||
                    typeof request.params.colour1 !== "number" ||
                    typeof request.params.colour2 !== "number") {
                    callback({
                        success: false,
                        error: "Missing or invalid parameters for createRide"
                    });
                    return;
                }
                var rideCreateArgs = {
                    rideType: request.params.rideType,
                    rideObject: request.params.rideObject,
                    entranceObject: request.params.entranceObject,
                    colour1: request.params.colour1,
                    colour2: request.params.colour2
                };
                context.executeAction("ridecreate", rideCreateArgs, function (result) {
                    if (result && typeof result.ride === "number") {
                        // Initialize track state for new ride (always reset in case of ID reuse)
                        rideTrackStates[result.ride] = {
                            history: []  // Array to store all placed track pieces for undo functionality
                        };
                        console.log("Initialized fresh track state for ride " + result.ride);
                        callback({
                            success: true,
                            payload: { rideId: result.ride }
                        });
                    } else {
                        callback({
                            success: false,
                            error: "Failed to create ride: " + (result && result.error ? result.error : "Unknown error")
                        });
                    }
                });
                break;
        }
    }
}

// Register the plugin
registerPlugin({
    name: "Ride Creation API Plugin",
    version: "0.1",
    authors: ["Markus"],
    type: "intransient",
    licence: "MIT",
    targetApiVersion: 103,
    main: main
});
