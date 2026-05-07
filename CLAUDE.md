# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the OpenRCT2 Ride Creation API - a TCP-based JSON API plugin for OpenRCT2 that allows programmatic control of ride construction. It's designed for reinforcement learning agents to build roller coasters and evaluate their performance using in-game ratings.

## Key Architecture

### Main Components

1. **TCP Server (ridecreation-api.js)**
   - Listens on port 8080
   - Handles JSON messages with newline delimiters
   - Processes requests through `processRequest()` function (line 215)

2. **Track State Management**
   - Global `rideTrackStates` object stores state per ride ID
   - Each ride state contains:
     - `history`: Array of all placed track pieces with position and connection data
     - `hasPlacedStation`: Boolean flag for entrance/exit placement
   - History enables undo functionality via `deleteLastTrackPiece` endpoint
   - States are cleared when rides are deleted to prevent conflicts
   - Track validation rules enforced via `trackConnectionRules` object

3. **API Endpoints** (handled in processRequest switch statement):
   - `createRide` - Creates new ride with specified parameters
   - `placeTrackPiece` - Places track with automatic validation
   - `placeEntranceExit` - Places entrance and exit for a ride's station (call after placing station pieces)
   - `deleteLastTrackPiece` - Removes most recent track piece for backtracking
   - `getValidNextPieces` - Returns valid track pieces for current position
   - `getRideStats` - Returns excitement/intensity/nausea ratings
   - `startRideTest` - Initiates ride testing mode
   - `listAllRides` - Lists all rides in park
   - `deleteAllRides` - Clears all rides and their states
   - `getAllTrackSegments` - Returns all available track types

### Track Validation System

The API uses a state-based validation system:
- Track pieces are categorized by their ending state (flat, up25, down60, etc.)
- Connection rules defined in `trackConnectionRules` specify allowed/forbidden connections
- `getTrackStateCategory()` function (line 116) maps track types to state categories
- Manual entrance/exit placement via `placeEntranceExit` endpoint after station is built
- Circuit completion detection when track loops back to start

## Development Notes

### Running the Plugin

This is an OpenRCT2 plugin written in JavaScript. To use:
1. Place `ridecreation-api.js` in the OpenRCT2 plugins folder
2. Start OpenRCT2 with console enabled
3. Plugin starts TCP server on port 8080 automatically
4. Connect via TCP with JSON messages ending in newline

### Testing

No automated tests exist. Testing requires:
1. Running OpenRCT2 with the plugin loaded
2. Connecting a TCP client to port 8080
3. Sending JSON requests per the API documentation

### Common Tasks

- **Add new endpoint**: Add case in `processRequest()` switch statement
- **Modify track validation**: Update `trackConnectionRules` object
- **Change track categorization**: Modify `getTrackStateCategory()` function
- **Debug connections**: Check console output in OpenRCT2

## Important Implementation Details

- All track placement coordinates use OpenRCT2's tile system
- Direction values: 0=west, 1=north, 2=east, 3=south
- Height units are OpenRCT2's internal height units (not meters/feet)
- Chain lift support only available on upward slopes (types 4, 5, 6)
- Track state is maintained per ride to enable proper validation
- Ride IDs can be reused after deletion (states are cleared)