# OpenRCT2 Ride Creation API Documentation

## Overview

The Ride Creation API is a TCP-based JSON API that allows programmatic control of ride construction in OpenRCT2. It was designed specifically for reinforcement learning agents to build roller coasters and evaluate their performance using in-game ratings.

### Features
- Create and manage rides programmatically
- Place track pieces with automatic validation
- Undo/delete last placed track piece for backtracking
- Manual entrance/exit placement for stations (via placeEntranceExit endpoint)
- Circuit completion detection (relative to the first placed piece)
- Real-time ride statistics (excitement, intensity, nausea)
- Chain lift support for slopes
- Banking and turn support
- Ride-object discovery via `listLoadedRideObjects` (for picking valid `rideObject` indices)

### Requirements
- **OpenRCT2 0.5.0 or newer** (uses the quickjs-ng scripting engine; older Duktape-based OpenRCT2 hosts will reject the plugin at load time via `minApiVersion: 111`).

### Connection Details
- **Protocol**: TCP
- **Port**: 8080 (configurable; set `RANDOM_PORT = true` at the top of `main()` in the plugin source to bind a random port in `[20000, 30000]`).
- **Host**: localhost
- **Message Format**: JSON with newline delimiter

## Protocol

### Request Format
```json
{
    "endpoint": "endpointName",
    "params": {
        "param1": "value1",
        "param2": "value2"
    }
}
```

Each request must be terminated with a newline character (`\n`).

### Response Format
```json
{
    "success": true,
    "payload": {
        // Response data
    }
}
```

Error responses:
```json
{
    "success": false,
    "error": "Error description"
}
```

## API Endpoints

### 1. createRide

Creates a new ride and initializes its state for track placement.

> **Tip:** call `listLoadedRideObjects` first to discover which `rideObject` indices are loaded in your current scenario / track designer session — the index that's valid varies per scenario.

#### Request
```json
{
    "endpoint": "createRide",
    "params": {
        "rideType": 52,             // 52 = Wooden Roller Coaster
        "rideObject": 0,            // Ride object variant (use listLoadedRideObjects to find valid indices)
        "entranceObject": 0,        // Entrance style
        "colour1": 0,               // Primary color
        "colour2": 0,               // Secondary color (must be < the object's vehicle preset count)
        "inspectionInterval": 2     // OPTIONAL — defaults to 2 (every30Minutes).
                                    // 0=every10min, 1=every20, 2=every30, 3=every45,
                                    // 4=hour, 5=2hours, 6=never
    }
}
```

> **OpenRCT2 0.5.0 note:** the `inspectionInterval` field is now visited by `RideCreateAction::AcceptParameters` and the strict quickjs-ng parameter visitor errors on missing fields. This plugin defaults it to `2` so existing clients don't have to send it; only set it if you want a non-default value.

#### Response
```json
{
    "success": true,
    "payload": {
        "rideId": 0  // Unique ride identifier
    }
}
```

### 2. placeTrackPiece

Places a track piece at specified coordinates with validation and automatic features.

#### Request
```json
{
    "endpoint": "placeTrackPiece",
    "params": {
        "tileCoordinateX": 67,    // X position in tiles
        "tileCoordinateY": 66,    // Y position in tiles
        "tileCoordinateZ": 14,    // Z position (height) in height units
        "direction": 0,           // 0=west, 1=north, 2=east, 3=south
        "ride": 0,                // Ride ID from createRide
        "trackType": 2,           // See Track Types Reference
        "rideType": 52,           // Must match ride's type
        "brakeSpeed": 0,          // Brake speed (0 for no brake)
        "colour": 0,              // Track color scheme
        "seatRotation": 0,        // Seat rotation angle
        "trackPlaceFlags": 0,     // Placement flags
        "isFromTrackDesign": true,// Design mode flag
        "hasChainLift": false     // Add chain lift (slopes only)
    }
}
```

#### Response
```json
{
    "success": true,
    "payload": {
        "message": "Track piece placed for ride 0",
        "nextEndpoint": {
            "x": 66,              // Next placement X
            "y": 66,              // Next placement Y
            "z": 14,              // Next placement Z
            "direction": 0        // Next placement direction
        },
        "isCircuitComplete": false,  // True when track loops back
        "circuitMessage": "Continue building...",
        "debug": {
            "placedAt": {"x": 67, "y": 66, "z": 14},
            "trackType": 2,
            "elemDirection": 0
        },
        "stationDetected": true      // Indicates a station piece was placed
    }
}
```

**Special Features:**
- **Station Pieces**: Station pieces are tracked, use `placeEntranceExit` endpoint after building station
- **Chain Lift Support**: Set `hasChainLift: true` for upward slopes (types 4, 5, 6)
- **Circuit Detection**: Automatically detects when track loops back to the **first placed piece's start position** (recorded internally as `state.firstPiece` on the first `placeTrackPiece` call). Works for any ride layout, not just rides built at a hardcoded location.

### 3. placeEntranceExit

Places entrance and exit for a ride's station. Call this after placing all station pieces.

#### Request
```json
{
    "endpoint": "placeEntranceExit",
    "params": {
        "rideId": 0    // Ride ID from createRide
    }
}
```

#### Response (Success)
```json
{
    "success": true,
    "payload": {
        "entrance": {"x": 67, "y": 65, "direction": 3},
        "exit": {"x": 67, "y": 67, "direction": 1},
        "message": "Successfully placed entrance and exit"
    }
}
```

#### Response (Partial Success)
```json
{
    "success": true,
    "payload": {
        "entrance": {"x": 67, "y": 65, "direction": 3},
        "exit": null,
        "warning": "Only partially successful - Could not place exit."
    }
}
```

**Notes:**
- Automatically finds all station pieces in the ride
- Tries to place entrance and exit next to each station piece until both are successfully placed
- Places entrance and exit perpendicular to the track direction
- If space next to first station piece is blocked, it will try subsequent station pieces
- Must be called after placing station pieces
- Returns error if no station pieces are found

### 4. getValidNextPieces

Returns valid track pieces that can follow the most-recently-placed piece for the
given ride. Backed by OpenRCT2's native `TrackSegment.getNextValidSegments(rideId)`
(PR #25840), which is ride-type-aware — covered variants, steep-slope gates, and
similar per-ride-def filters are applied automatically.

If no piece has been placed yet for the ride, returns a conservative initial set
(Flat, EndStation, BeginStation, MiddleStation) and `lastTrackType` / `position`
as `null`.

#### Request
```json
{
    "endpoint": "getValidNextPieces",
    "params": {
        "rideId": 0  // Ride ID to check
    }
}
```

#### Response
```json
{
    "success": true,
    "payload": {
        "validPieces": [0, 6, 12, 16, 17, 42, 43],   // Valid track type IDs
        "validSegments": [                            // Same list with full segment data
            {
                "type": 0,
                "description": "Flat",
                "trackGroup": 0,
                "length": 32,
                "beginZ": 0, "endZ": 0,
                "beginSlope": 0, "endSlope": 0,
                "beginBank": 0, "endBank": 0,
                "beginDirection": 0, "endDirection": 0,
                "turnDirection": "straight",
                "slopeDirection": "none"
            }
            // ... one entry per type in validPieces
        ],
        "lastTrackType": 2,                          // Previously placed type
        "stateCategory": null,                       // Deprecated; always null
        "position": {
            "x": 66,
            "y": 66,
            "z": 14,
            "direction": 0
        }
    }
}
```

`validPieces` is kept as a flat array of numeric type IDs for wire-compatibility
with pre-migration clients. `validSegments` is the same list as rich objects.

### 5. getRideStats

Returns the ride's ratings after testing is complete.

#### Request
```json
{
    "endpoint": "getRideStats",
    "params": {
        "rideId": 0
    }
}
```

#### Response
```json
{
    "success": true,
    "payload": {
        "excitement": 6.54,  // Excitement rating (0-10+)
        "intensity": 5.23,   // Intensity rating (0-10+)
        "nausea": 3.12      // Nausea rating (0-10+)
    }
}
```

### 6. startRideTest

Starts the ride in test mode to calculate ratings.

#### Request
```json
{
    "endpoint": "startRideTest",
    "params": {
        "rideId": 0
    }
}
```

#### Response
```json
{
    "success": true,
    "payload": "Ride 0 started in test mode."
}
```

### 7. listAllRides

Lists all rides currently in the park.

#### Request
```json
{
    "endpoint": "listAllRides"
}
```

#### Response
```json
{
    "success": true,
    "payload": [
        {
            "id": 0,
            "name": "Ride 1",
            "type": 52
        }
    ]
}
```

### 8. deleteLastTrackPiece

Removes the most recently placed track piece from a ride. Useful for backtracking when the RL agent detects collisions or wants to try a different path.

**Note:** This endpoint only removes track pieces, not entrances/exits. Entrances and exits are managed separately through the `placeEntranceExit` endpoint.

#### Request
```json
{
    "endpoint": "deleteLastTrackPiece",
    "params": {
        "rideId": 0  // ID of the ride to remove track from
    }
}
```

#### Response (when pieces remain)
```json
{
    "success": true,
    "payload": {
        "message": "Track piece removed from ride 0",
        "piecesRemaining": 5,  // Number of pieces still on the track
        "nextEndpoint": {       // Where to continue building from
            "x": 65,
            "y": 66,
            "z": 14,
            "direction": 0
        },
        "lastTrackType": 2      // Type of the now-last piece
    }
}
```

#### Response (when no pieces remain)
```json
{
    "success": true,
    "payload": {
        "message": "Track piece removed from ride 0",
        "piecesRemaining": 0,
        "nextEndpoint": null,   // No pieces left to build from
        "lastTrackType": null
    }
}
```

#### Error Response
```json
{
    "success": false,
    "error": "No track pieces to delete for ride 0"
}
```

### 9. deleteAllRides

Deletes all rides from the park and clears their states.

#### Request
```json
{
    "endpoint": "deleteAllRides"
}
```

#### Response
```json
{
    "success": true,
    "payload": "Deleted all rides."
}
```

### 10. getAllTrackSegments

Returns information about all available track segment types.

#### Request
```json
{
    "endpoint": "getAllTrackSegments"
}
```

#### Response
```json
{
    "success": true,
    "payload": [
        {
            "type": 0,
            "description": "Flat",
            "trackGroup": "flat",
            "length": 1,
            "beginZ": 0,
            "endZ": 0,
            "beginSlope": 0,
            "endSlope": 0,
            "beginBank": 0,
            "endBank": 0,
            "beginDirection": 0,
            "endDirection": 0,
            "turnDirection": "straight",
            "slopeDirection": "none"
        }
        // ... more segments
    ]
}
```

Each entry comes from `serializeTrackSegment` — the same shape returned by
`getValidNextPieces.validSegments`.

### 11. listLoadedRideObjects

Returns every ride object the OpenRCT2 host currently has loaded, with its slot index, identifier, friendly name, and the ride type(s) the object supports. Use this to pick a valid `rideObject` index before calling `createRide` — the slot that holds your wooden coaster (or any other ride) varies per scenario / track designer session, so hardcoding `rideObject: 0` is fragile.

#### Request
```json
{
    "endpoint": "listLoadedRideObjects"
}
```

#### Response
```json
{
    "success": true,
    "payload": [
        {
            "index": 0,
            "identifier": "rct2.ride.ptct1",
            "name": "Wooden Roller Coaster Trains",
            "rideType": [52, 255, 255]
        }
        // ... more objects
    ]
}
```

The `rideType` array contains up to 3 ride types the object can be used as; `255` means "unused slot". Pick an `index` whose `rideType` includes the type you want to pass as `rideType` to `createRide`.

## Track Types Reference

### Basic Track Pieces
| ID | Type | Description | Chain Lift Support |
|----|------|-------------|-------------------|
| 0 | Flat | Straight flat piece | No |
| 1 | EndStation | End of station | No |
| 2 | BeginStation | Beginning of station (triggers entrance/exit) | No |
| 3 | MiddleStation | Middle station piece | No |

### Slopes
| ID | Type | Description | Chain Lift Support |
|----|------|-------------|-------------------|
| 4 | Up25 | 25° upward slope | Yes |
| 5 | Up60 | 60° upward slope | Yes |
| 10 | Down25 | 25° downward slope | No |
| 11 | Down60 | 60° downward slope | No |

### Slope Transitions
| ID | Type | Description | Chain Lift Support |
|----|------|-------------|-------------------|
| 6 | FlatToUp25 | Transition from flat to 25° up | Yes |
| 7 | Up25ToUp60 | Transition from 25° to 60° up | No |
| 8 | Up60ToUp25 | Transition from 60° to 25° up | No |
| 9 | Up25ToFlat | Transition from 25° up to flat | No |
| 12 | FlatToDown25 | Transition from flat to 25° down | No |
| 13 | Down25ToDown60 | Transition from 25° to 60° down | No |
| 14 | Down60ToDown25 | Transition from 60° to 25° down | No |
| 15 | Down25ToFlat | Transition from 25° down to flat | No |

### Turns
| ID | Type | Description |
|----|------|-------------|
| 16 | LeftQuarterTurn5Tiles | Large left turn |
| 17 | RightQuarterTurn5Tiles | Large right turn |
| 42 | LeftQuarterTurn3Tiles | Small left turn |
| 43 | RightQuarterTurn3Tiles | Small right turn |

### Banking
| ID | Type | Description |
|----|------|-------------|
| 18 | FlatToLeftBank | Transition to left bank |
| 19 | FlatToRightBank | Transition to right bank |
| 20 | LeftBankToFlat | Left bank to flat |
| 21 | RightBankToFlat | Right bank to flat |
| 32 | LeftBank | Left banked piece |
| 33 | RightBank | Right banked piece |

### Banked Turns
| ID | Type | Description |
|----|------|-------------|
| 22 | BankedLeftQuarterTurn5Tiles | Large banked left turn |
| 23 | BankedRightQuarterTurn5Tiles | Large banked right turn |
| 44 | LeftBankedQuarterTurn3Tiles | Small banked left turn |
| 45 | RightBankedQuarterTurn3Tiles | Small banked right turn |

## Track Validation Rules

The API enforces track connection rules based on the current track state:

### State Categories
- **station**: Station pieces
- **flat**: Flat straight pieces
- **up25**: 25° upward slope
- **up60**: 60° upward slope
- **down25**: 25° downward slope
- **down60**: 60° downward slope
- **turn**: Turn pieces
- **left_bank**: Left banking
- **right_bank**: Right banking
- **flat_to_left_bank**: Transitioning to left bank
- **flat_to_right_bank**: Transitioning to right bank

### Station Placement
**Important:** Station pieces can only be placed:
- At the beginning of a ride (when no track exists)
- From other station pieces (to extend the station)

Once you've built past the station, you cannot build another station. This prevents RL agents from creating multiple stations which would be invalid.

### Connection Rules

#### From Station
- ✅ Can connect to: EndStation, MiddleStation only

#### From End Station
- ✅ Can connect to: flat, slope transitions, turns, banking transitions

#### From Flat
- ✅ Can connect to: flat, slope transitions, turns, banking transitions

#### From Up25
- ✅ Can connect to: continue up25, transition to flat, transition to up60

#### From Up60
- ✅ Can connect to: continue up60, transition to up25

#### From Down25
- ✅ Can connect to: continue down25, transition to flat, transition to down60

#### From Down60
- ✅ Can connect to: continue down60, transition to down25

#### From Turn
- ✅ Can connect to: flat, turns, gentle transitions, banking starts

#### From Banking States
- ✅ Left Bank: continue left bank, left-bank-to-flat, banked left turns
- ✅ Right Bank: continue right bank, right-bank-to-flat, banked right turns

## Example Usage (Python)

### Basic Connection
```python
import socket
import json

def send_request(sock, request):
    message = json.dumps(request) + "\n"
    sock.sendall(message.encode("utf-8"))
    file_obj = sock.makefile("r")
    line = file_obj.readline()
    return json.loads(line)

# Connect to API
sock = socket.create_connection(("localhost", 8080))
```

### Create Ride and Build Track
```python
# Create ride
req = {
    "endpoint": "createRide",
    "params": {
        "rideType": 52,
        "rideObject": 0,
        "entranceObject": 0,
        "colour1": 0,
        "colour2": 1
    }
}
resp = send_request(sock, req)
ride_id = resp["payload"]["rideId"]

# Place station pieces
for i in range(3):  # Place 3 station pieces
    track_type = 2 if i == 0 else 3  # BeginStation, then MiddleStation
    req = {
        "endpoint": "placeTrackPiece",
        "params": {
            "tileCoordinateX": 67 - i,  # Move left for each piece
            "tileCoordinateY": 66,
            "tileCoordinateZ": 14,
            "direction": 0,
            "ride": ride_id,
            "trackType": track_type,
            "rideType": 52,
            "brakeSpeed": 0,
            "colour": 0,
            "seatRotation": 0,
            "trackPlaceFlags": 0,
            "isFromTrackDesign": True
        }
    }
    resp = send_request(sock, req)
    next_pos = resp["payload"]["nextEndpoint"]

# Place entrance and exit after station is complete
req = {
    "endpoint": "placeEntranceExit",
    "params": {
        "rideId": ride_id
    }
}
resp = send_request(sock, req)
print(f"Entrance/exit placed: {resp['payload']}")

# Get valid pieces for next position
req = {
    "endpoint": "getValidNextPieces",
    "params": {"rideId": ride_id}
}
resp = send_request(sock, req)
valid_pieces = resp["payload"]["validPieces"]

# Place upward slope with chain lift
req = {
    "endpoint": "placeTrackPiece",
    "params": {
        "tileCoordinateX": next_pos["x"],
        "tileCoordinateY": next_pos["y"],
        "tileCoordinateZ": next_pos["z"],
        "direction": next_pos["direction"],
        "ride": ride_id,
        "trackType": 6,  # FlatToUp25
        "rideType": 52,
        "brakeSpeed": 0,
        "colour": 0,
        "seatRotation": 0,
        "trackPlaceFlags": 0,
        "isFromTrackDesign": True,
        "hasChainLift": True  # Add chain lift
    }
}
resp = send_request(sock, req)

# Example: Delete last piece if we detect a collision
if track_would_collide:  # Your collision detection logic
    req = {
        "endpoint": "deleteLastTrackPiece",
        "params": {"rideId": ride_id}
    }
    resp = send_request(sock, req)
    if resp["success"]:
        next_pos = resp["payload"]["nextEndpoint"]
        print(f"Removed piece, can rebuild from: {next_pos}")

# Check if circuit is complete
if resp["payload"]["isCircuitComplete"]:
    print("Circuit complete! Ready for testing.")
    
    # Start ride test
    req = {
        "endpoint": "startRideTest",
        "params": {"rideId": ride_id}
    }
    send_request(sock, req)
    
    # Get ratings (after test completes)
    req = {
        "endpoint": "getRideStats",
        "params": {"rideId": ride_id}
    }
    resp = send_request(sock, req)
    stats = resp["payload"]
    print(f"Excitement: {stats['excitement']}")
    print(f"Intensity: {stats['intensity']}")
    print(f"Nausea: {stats['nausea']}")
```

## Error Handling

### Common Errors

1. **"Missing endpoint"** - Request doesn't include endpoint field
2. **"Unknown endpoint: X"** - Endpoint name doesn't match any registered handler (the dispatcher is now a Map; previously unknown endpoints silently dropped, leaving clients hanging)
3. **"Missing parameter: X"** / **"Missing or invalid parameter: X"** - Required parameter X not provided or wrong type
4. **"Ride not found"** / **"Ride X not found"** - Invalid ride ID
5. **"Track has no valid next position"** - Track piece doesn't connect properly
6. **"Failed to place track piece: ..."** - Invalid placement (collision, invalid position). The trailing string is OpenRCT2's own action error.
7. **"Failed to create ride: Invalid action parameters."** - One of `rideType` / `rideObject` / `entranceObject` / `colour1` / `colour2` is invalid for your current scenario, or the chosen `rideObject` slot isn't loaded. Use `listLoadedRideObjects` to find a valid `rideObject`.
8. **"Invalid JSON"** - Request line wasn't a valid JSON object terminated by newline.

### Best Practices

1. Always check `success` field in responses
2. Use `getValidNextPieces` before placing to ensure valid connections
3. Store `nextEndpoint` from each placement for the next piece
4. Check `isCircuitComplete` to know when track is ready for testing
5. Use `deleteLastTrackPiece` to backtrack when collision detection triggers
6. Delete all rides before starting a new training session

## Manual Station Management

### Entrance/Exit Placement
After placing all station pieces, use the `placeEntranceExit` endpoint to add entrance and exit:
- Automatically finds all station pieces in the ride
- Attempts to place entrance and exit next to each station piece
- Places entrance on one side perpendicular to track
- Places exit on the opposite side
- Directions are set to face appropriately (entrance towards station, exit away)
- If space next to a station piece is blocked, automatically tries the next station piece
- Continues until both entrance and exit are successfully placed or all station pieces have been tried
- Placement adjusts based on track direction to avoid blocking the track path

### Circuit Completion Detection
The API automatically detects when a track completes a circuit:
- The first piece placed for a ride is recorded internally as the circuit anchor (`state.firstPiece`).
- After every subsequent `placeTrackPiece`, the iterator's next position is compared against that anchor (x, y, z, direction).
- When all four match, `isCircuitComplete: true` is returned along with the `circuitMessage` "Circuit complete! Track connects back to station - ready for testing!".
- If you fully undo the track via `deleteLastTrackPiece` (`piecesRemaining` reaches 0), the anchor resets — the next placement starts a fresh circuit-detection state.

### State Management
- Track states are maintained per ride in a `Map<rideId, RideState>`.
- States are cleared when rides are deleted (`deleteAllRides` or individual demolish via the game).
- Manually-created rides (built via the OpenRCT2 UI rather than the API) are still usable — the API lazily initializes state for them on the first `placeTrackPiece` call.

## Reinforcement Learning Integration

This API is designed for RL agents with the following considerations:

### State Space
- Current track position (x, y, z, direction)
- Valid next pieces list
- Track state category
- Circuit completion status

### Action Space
- Select from valid track pieces only
- Binary decision for chain lift on slopes

### Reward Function
- Use ride ratings (excitement, intensity, nausea) after testing
- Bonus for completing circuit
- Penalty for invalid placements

### Episode Management
1. Call `deleteAllRides` to reset environment
2. Create new ride with `createRide`
3. Build track until circuit completes or max steps
4. Test ride and get ratings for reward
5. Repeat for next episode

## Version History

- **v0.2** — Migrated from Duktape to quickjs-ng for OpenRCT2 0.5.0+. Internal rewrite to async/await with a `Map`-based dispatcher; ~30% smaller plugin source. Behaviour fixes included:
  - Circuit detection is now relative to the first placed piece (was hardcoded to `(61, 66, 14, dir=0)` which only worked for one specific layout).
  - `deleteLastTrackPiece` now resets `state.firstPiece` and `state.isComplete` when it pops the last piece, so building a fresh ride afterwards isn't compared against the deleted ride's anchor.
  - Unknown endpoints now return `{success: false, error: "Unknown endpoint: <name>"}` instead of silently dropping requests.
  - `createRide` now passes `inspectionInterval` (required by OpenRCT2 0.5.0's strict `JSToGameActionParameterVisitor`).
  - New `listLoadedRideObjects` endpoint for discovering valid `rideObject` indices.
  - `targetApiVersion: 111` and `minApiVersion: 111` set for OpenRCT2 0.5.0.
- **v0.1** - Initial API with basic track placement, validation, automatic entrance/exit placement, and circuit detection.