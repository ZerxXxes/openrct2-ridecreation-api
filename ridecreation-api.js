// ---------------------------------------------------------------------------
//  Utility / Command Functions
// ---------------------------------------------------------------------------

function findRideById(rideId)
{
    var found = null;
    map.rides.forEach(function(ride) {
        if (ride.id === rideId)
        {
            found = ride;
        }
    });
    return found;
}

/**
 * Function to list all rides.
 */
function listAllRides()
{
    // map.rides is an array-like of Ride objects.
    var ridesArray = [];
    map.rides.forEach(function(ride) {
        ridesArray.push({
            id: ride.id,
            name: ride.name,
            type: ride.type
        });
    });

    if (ridesArray.length === 0)
    {
        return {
            success: true,
            message: "No rides found in this park.",
            rides: []
        };
    }

    return {
        success: true,
        message: "Found " + ridesArray.length + " ride(s).",
        rides: ridesArray
    };
}

function deleteAllRides()
{
    try
    {
        map.rides.forEach(function(ride) 
        {
            context.executeAction("ridedemolish", {
                ride: ride.id,
                modifyType: 0 // 0 => demolish, 1 => renew
            });
        });

        return { success: true, message: "All rides have been demolished." };
    }
    catch (e)
    {
        return { success: false, message: "Failed to demolish rides: " + e.message };
    }
}

/**
 * Function to start a ride in test mode (status = 2).
 */
function startRideTest(rideId)
{
    var ride = findRideById(rideId);
    if (!ride)
    {
        return {
            success: false,
            message: "Ride with ID " + rideId + " not found."
        };
    }

    try
    {
        // Use the correct action name: "ridesetstatus"
        context.executeAction("ridesetstatus", {
            ride: rideId,
            status: 2 // 2 => testing
        });

        return {
            success: true,
            message: "Ride started in test mode."
        };
    }
    catch (e)
    {
        return {
            success: false,
            message: "Failed to start ride in test mode: " + e.message
        };
    }
}

/**
 * Function to get a rides stats
 */

function getRideStats(rideId)
{
    var ride = findRideById(rideId);
    if (!ride)
    {
        return {
            success: false,
            message: "Ride with ID " + rideId + " not found."
        };
    }

    try
    {
        // -1 for excitement often indicates "no stats computed yet."
        // If it’s not -1, it’s typically stored as a two-decimal integer (e.g., 652 => 6.52).
        var e = ride.excitement;  // -1 or integer
        var i = ride.intensity;   // 0 or integer
        var n = ride.nausea;      // 0 or integer

        // Convert any non-negative values from "fixed two-decimal integer" to a float.
        // If it's -1, you can interpret that as “no stats”.
        var excitement = (e >= 0) ? (e / 100.0) : null;
        var intensity  = (i >= 0) ? (i / 100.0) : null;
        var nausea     = (n >= 0) ? (n / 100.0) : null;

        return {
            success: true,
            message: "Ride stats fetched successfully.",
            stats: {
                excitement: excitement,
                intensity: intensity,
                nausea: nausea
            }
        };
    }
    catch (e)
    {
        return {
            success: false,
            message: "Failed to fetch ride stats: " + e.message
        };
    }
}

/**
 * Dump all (enumerable) properties on the ride object as JSON so we can see
 * what fields actually exist. 
 */
function dumpRideObject(rideId)
{
    var ride = findRideById(rideId);
    if (!ride)
    {
        return {
            success: false,
            message: "Ride with ID " + rideId + " not found."
        };
    }

    // Attempt to enumerate properties
    try
    {
        var rideData = {};
        for (var key in ride)
        {
            // If ride[key] is inaccessible or throws, catch it
            try
            {
                var val = ride[key];
                rideData[key] = val;
            }
            catch (err)
            {
                rideData[key] = "Error accessing property: " + err.message;
            }
        }

        return {
            success: true,
            message: "Ride object dump successful.",
            rideDump: rideData
        };
    }
    catch (e)
    {
        return {
            success: false,
            message: "Failed to dump ride object: " + e.message
        };
    }
}

// ---------------------------------------------------------------------------
//  Command Dispatch
// ---------------------------------------------------------------------------

/**
 * Parses a single JSON command string, executes the corresponding function, 
 * and returns a JSON string with the result.
 * 
 * @param {string} data - the raw JSON string from the socket
 * @returns {string} - a JSON-encoded string of the result
 */
function handleIncomingCommand(data)
{
    var response;
    try
    {
        var parsed = JSON.parse(data);

        switch (parsed.command)
        {
            case "listAllRides":
                response = listAllRides();
                break;

            case "deleteAllRides":
                response = deleteAllRides();
                break;

            case "startRideTest":
                response = startRideTest(parsed.rideId);
                break;

            case "getRideStats":
                response = getRideStats(parsed.rideId);
                break;

            case "dumpRideObject":
                response = dumpRideObject(parsed.rideId);
                break;

            default:
                response = {
                    success: false,
                    message: "Unknown command: " + parsed.command
                };
        }
    }
    catch (err)
    {
        response = {
            success: false,
            message: "Error parsing/handling command: " + err
        };
    }

    // Return a JSON-formatted reply
    return JSON.stringify(response);
}

// ---------------------------------------------------------------------------
//  Main Plugin Initialization
// ---------------------------------------------------------------------------

function main()
{
    // Create a local TCP server listening on port 8080
    var server = network.createListener();

    server.on("connection", function(conn)
    {
        var buffer = "";

        conn.on("data", function(dataChunk)
        {
            // Convert to string, accumulate
            buffer += dataChunk.toString();

            // Split on newline to find complete JSON messages
            var lines = buffer.split("\n");
            buffer = lines.pop(); // Keep the trailing incomplete line

            // Process each complete line
            lines.forEach(function(line)
            {
                var trimmed = line.trim();
                if (trimmed.length > 0)
                {
                    var reply = handleIncomingCommand(trimmed);
                    // Send reply back, plus newline
                    conn.write(reply + "\n");
                }
            });
        });
    });

    server.listen(8080);
    console.log("Socket JSON Plugin: Listening on port 8080...");
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

