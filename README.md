# OpenRCT2 Ride Creation API Documentation

## Overview

The Ride Creation API is a TCP-based JSON API that allows programmatic control of ride construction in OpenRCT2. It was designed specifically for reinforcement learning agents to build roller coasters and evaluate their performance using in-game ratings.

### Features
- Create and manage rides programmatically
- Place track pieces with automatic validation
- Automatic entrance/exit placement for stations
- Circuit completion detection
- Real-time ride statistics (excitement, intensity, nausea)
- Chain lift support for slopes
- Banking and turn support

### Connection Details
- **Protocol**: TCP
- **Port**: 8080
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

#### Request
```json
{
    "endpoint": "createRide",
    "params": {
        "rideType": 52,        // 52 = Wooden Roller Coaster
        "rideObject": 0,       // Ride object variant
        "entranceObject": 0,   // Entrance style
        "colour1": 0,          // Primary color
        "colour2": 1           // Secondary color
    }
}
```

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
        "entranceExitPlaced": {      // Only on first station
            "entrance": {"x": 67, "y": 65, "direction": 3},
            "exit": {"x": 67, "y": 67, "direction": 1}
        }
    }
}
```

**Special Features:**
- **Automatic Entrance/Exit**: When the first station piece (type 2) is placed, entrance and exit are automatically placed on adjacent tiles perpendicular to the track direction
- **Chain Lift Support**: Set `hasChainLift: true` for upward slopes (types 4, 5, 6)
- **Circuit Detection**: Automatically detects when track completes a circuit back to the station

### 3. getValidNextPieces

Returns valid track pieces that can be placed at the current position based on track validation rules.

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
        "validPieces": [0, 6, 12, 16, 17, 42, 43],  // Valid track type IDs
        "lastTrackType": 2,                         // Previously placed type
        "stateCategory": "station",                 // Current state category
        "position": {
            "x": 66,
            "y": 66,
            "z": 14,
            "direction": 0
        }
    }
}
```

### 4. getRideStats

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

### 5. startRideTest

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

### 6. listAllRides

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

### 7. deleteAllRides

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

### 8. getAllTrackSegments

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
            "beginDirection": 0,
            "endDirection": 0,
            "beginBank": 0,
            "endBank": 0
        }
        // ... more segments
    ]
}
```

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

### Connection Rules

#### From Station
- ✅ Can connect to: flat, gentle up slopes, turns, banking transitions
- ❌ Cannot connect to: down slopes, steep slopes, banked pieces

#### From Flat
- ✅ Can connect to: flat, slope transitions, turns, stations, banking transitions
- ❌ Cannot connect to: direct steep slopes, direct banking

#### From Up25
- ✅ Can connect to: continue up25, transition to flat, transition to up60
- ❌ Cannot connect to: down slopes, direct steep, wrong transitions

#### From Up60
- ✅ Can connect to: continue up60, transition to up25
- ❌ Cannot connect to: down slopes, flat, wrong transitions

#### From Down25
- ✅ Can connect to: continue down25, transition to flat, transition to down60
- ❌ Cannot connect to: up slopes, wrong transitions

#### From Down60
- ✅ Can connect to: continue down60, transition to down25
- ❌ Cannot connect to: up slopes, flat, wrong transitions

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

# Place station piece (automatically places entrance/exit)
req = {
    "endpoint": "placeTrackPiece",
    "params": {
        "tileCoordinateX": 67,
        "tileCoordinateY": 66,
        "tileCoordinateZ": 14,
        "direction": 0,
        "ride": ride_id,
        "trackType": 2,  # BeginStation
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
2. **"Missing parameter: X"** - Required parameter X not provided
3. **"Ride not found"** - Invalid ride ID
4. **"Track has no valid next position"** - Track piece doesn't connect properly
5. **"Failed to place track piece"** - Invalid placement (collision, invalid position)

### Best Practices

1. Always check `success` field in responses
2. Use `getValidNextPieces` before placing to ensure valid connections
3. Store `nextEndpoint` from each placement for the next piece
4. Check `isCircuitComplete` to know when track is ready for testing
5. Delete all rides before starting a new training session

## Automatic Features

### Entrance/Exit Placement
When the first station piece (BeginStation, type 2) is placed:
- Entrance is automatically placed on one side perpendicular to track
- Exit is placed on the opposite side
- Directions are set to face appropriately (entrance towards station, exit away)
- Placement adjusts based on track direction to avoid blocking the track path

### Circuit Completion Detection
The API automatically detects when a track completes a circuit:
- Checks if next placement position matches station start
- Verifies direction alignment
- Returns `isCircuitComplete: true` when circuit is ready
- Provides status message for user feedback

### State Management
- Track states are maintained per ride
- States are cleared when rides are deleted
- Prevents state conflicts when ride IDs are reused

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

- **v0.1** - Initial API with basic track placement, validation, automatic entrance/exit placement, and circuit detection