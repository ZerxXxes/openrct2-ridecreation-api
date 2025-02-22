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
                        length: seg.length
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
                    trackPlaceFlags: request.params.trackPlaceFlags,
                    isFromTrackDesign: request.params.isFromTrackDesign
                };
                context.executeAction("trackplace", trackPlaceArgs, function(result) {
                    // Debug: log the position returned by trackplace (in game units).
                    if (!result || (result.error && result.error !== "")) {
                        callback({
                            success: false,
                            error: "Failed to place track piece: " +
                                (result && result.error ? result.error : "Unknown error")
                        });
                    } else {
                        // For debugging, get the tile using the API–provided tile coordinates.
                        var tile = map.getTile(request.params.tileCoordinateX, request.params.tileCoordinateY);
                        if (!tile) {
                            callback({ success: false, error: "Tile not found" });
                            return;
                        }
                        var elem_index = -1;
                        for (var i = 0; i < tile.numElements; i++) {
                            if (tile.elements[i].baseZ === request.params.tileCoordinateZ*8 && tile.elements[i].type === 'track') {
                                elem_index = i;
                                break;
                            }
                        }
                        if (elem_index === -1) {
                            callback({ success: false, error: "Could not find track element on tile" });
                            return;
                        }
                        // Use the actual placed position (result.position) for the track iterator.
                        var iterator = map.getTrackIterator({ x: result.position.x, y: result.position.y }, elem_index);
                        if (!iterator || !iterator.nextPosition) {
                            callback({ success: false, error: "Track iterator not available on X: " + result.position.x + " Y: " + result.position.y });
                            return;
                        }
                        var responsePayload = {
                            message: "Track piece placed for ride " + request.params.ride,
                            // Return the endpoint from the iterator.
                            nextEndpoint: {
                                x: iterator.nextPosition.x / 32,
                                y: iterator.nextPosition.y / 32,
                                z: iterator.nextPosition.z / 8,
                                direction: iterator.nextPosition.direction
                            }
                        };
                        callback({ success: true, payload: responsePayload });
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
