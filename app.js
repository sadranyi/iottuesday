require('dotenv').config();
const chalk = require('chalk');
const ClientFromConnectionString = require('azure-iot-device-mqtt').clientFromConnectionString;
const Message = require('azure-iot-device').Message;
const Rest = require('azure-maps-rest');

const truckNum = 1;
const connString = process.env.CONN_STRING;

// Use the Azure IoT device SDK for devices that connect to Azure IoT Central.
let truckIdentification = `Truck number ${truckNum}`;
let subscriptionKeyCredential = new Rest.SubscriptionKeyCredential(process.env.AZURE_MAPS_KEY);
let pipeline = Rest.MapsURL.newPipeline(subscriptionKeyCredential);
let routeUrl = new Rest.RouteURL(pipeline);
let client = ClientFromConnectionString(connString);

// Truck globals initialized to the starting state of the truck.
let stateEnum = Object.freeze({
    ready: 'ready',
    enroute: 'enroute',
    delivering: 'delivering',
    returning: 'returning',
    loading: 'loading',
    dumping: 'dumping'
});

let contentsEnum = Object.freeze({
    full: 'full',
    melting: 'melting',
    empty: 'empty'
});

let fanEnum = Object.freeze({
    on: 'on',
    off: 'off',
    failed: 'failed'
});

const deliverTime = 600;            // Time to complete delivery, in seconds
const loadingTIme = 800;            // Time to load contents, in seconds
const dumpingTime = 400;            // Time to dump melted contents.
const tooWarmThreshold = 2;         // Degrees in C that is too warm for content
const tooWarmTooLong = 60;          // TIme in seconds for content to start melting if temps above threshold
const noEvent = 'none';

let timeOnCurrentTask = 0;          // Time on current task in seconds
let interval = 60;                  // Time interval in seconds
let tooWarmPeriod = 0;              // Time that contents are too warm in seconds
let temp = -2;                      // CUrrent temp of content in degrees C
let baseLat = 47.644702;            // Base position latitude 
let baseLon = -122.130137;          // Base position longitude 
let currentLat = baseLat;           // Current position latitude
let currentLon = baseLon;           // Current position longitude
let destinationLat;                 // Destination latitude
let destinationLon;                 // Destination longitude

let fan = fanEnum.on;               // Cooling fan state
let contents = contentsEnum.full;    // Truck Content State
let state = stateEnum.ready;        // Truck is full and ready to go
let optimalTemperature = -5;        // Setting - can be changed by the operator from IoT Central 
let eventText = noEvent;            // Text to send to the IoT Central Operator


// Latitude and longitude positions of customers
let customer = [
    [47.645892, -122.336954],       // Gasworks Park
    [47.688741, -122.402965],       // Golden Gardens Park
    [47.551093, -122.249266],       // Seward Park
    [47.555698, -122.065996],       // Lake Sammamish Park
    [47.663747, -122.120879],       // Marymoor Park
    [47.857295, -122.316355],       // Meadowdale Beach Park
    [47.530250, -122.393055],       // Lincoln Park
    [47.503266, -122.200194],       // Gene Coulon Park
    [47.591094, -122.226833],       // Luther Bank Park
    [47.544120, -122.221673]        // Pioneer Park
];

let path = [];                      // lat/lon steps for the route
let timeOnPath = [];                // Time in seconds for each section of the route
let truckOnSection;                 // The current path section the truck is on
let truckSectionsCompletedTime;     // The time the truck has spent on previous completed sections

function greenMessage(text) {
    console.log(`${chalk.green(text)}`);
}

function redMessage(text) {
    console.log(`${chalk.red(text)}`);
}

function Degrees2Radians(deg){
    return deg * Math.PI / 180;
}

function DistanceInMeters(lat1, lon1, lat2, lon2){
    let dlon = Degrees2Radians(lon2 - lon1);
    let dlat = Degrees2Radians(lat2 - lat1);

    let a = (Math.sin(dlat / 2) * Math.sin(dlat / 2)) + Math.cos(Degrees2Radians(lat1) * Math.cos(Degrees2Radians(lat2)) * (Math.sin(dlon / 2) * Math.sin(dlon / 2)));
    let angle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    let meters = angle * 6371000;

    return meters;
}

function Arrived(){
    // If the truck is within 10 meters of the destination, call it good
    return (DistanceInMeters(currentLat, currentLon, destinationLat, destinationLon) < 10);
}

function UpdatePosition(){
    while ((truckSectionsCompletedTime + timeOnPath[truckOnSection] < timeOnCurrentTask) && (truckOnSection < timeOnPath.length - 1)) {
        // truck has moved onto the next section
        truckSectionsCompletedTime += timeOnPath[truckOnSection];
        ++truckOnSection;
    }

    // Ensure remainder is 0 to 1 as interval may take count over what is needed
    let remainderFraction = Math.min(1, (timeOnCurrentTask - truckSectionsCompletedTime) / timeOnPath[truckOnSection]);

    // The Path should be one entry longer than the timeOnPath array
    // Find how far along the section the truck has moved
    currentLat = path[truckOnSection][0] + remainderFraction * (path[truckOnSection + 1][0] - path[truckOnSection][0]);
    currentLon = path[truckOnSection][1] + remainderFraction * (path[truckOnSection + 1][1] - path[truckOnSection][1]);
}


function GetRoute(newState){
    // set the state to ready, until the new route arrives
    state = stateEnum.ready;
    let coordinates = [
        [currentLon, currentLat],
        [destinationLon, destinationLat]
    ];

    let results = routeUrl.calculateRouteDirections(Rest.Aborter.timeout(10000), coordinates);
    results.then(data => {
        greenMessage(`Route found. Number of Points = ${ JSON.stringify(data.routes[0].legs[0].points.length, null, 4)}`);

        // Clear the Path
        path.length = 0;

        // start with the current location
        path.push([currentLat, currentLon]);

        // Retrieve the routes and push the points ont the array 
        for (let n =0; n < data.routes[0].legs[0].points.length; n++){
            let x = data.routes[0].legs[0].points[n].latitude;
            let y = data.routes[0].legs[0].points[n].longitude;

            path.push([x, y]);
        }

        // finish with the destination
        path.push([destinationLat, destinationLon]);

        // store the path length and time taken, to calculate the average speed
        let meters = data.routes[0].summary.lengthInMeters;
        let seconds = data.routes[0].summary.travelTimeInSeconds;
        let pathSpeed = meters / seconds;

        let distanceApartInMeters;
        let timeForOneSection;

        // Clear the time on path array.
        timeOnPath.length = 0;

        // Calculate how much time is required for each section of the path.
        for (var t = 0; t < path.length - 1; t++) {

            // Calculate distance between the two path points, in meters.
            distanceApartInMeters = DistanceInMeters(path[t][0], path[t][1], path[t + 1][0], path[t + 1][1]);

            // Calculate the time for each section of the path.
            timeForOneSection = distanceApartInMeters / pathSpeed;
            timeOnPath.push(timeForOneSection);
        }
        truckOnSection = 0;
        truckSectionsCompletedTime = 0;
        timeOnCurrentTask = 0;

        // Update the state now the route has arrived. One of: enroute or returning.
        state = newState;
    }, reason => {
        // Error: THe request was aborted 
        redMessage(reason);
        eventText = "Failed to find Map route";
    });
}

function CmdGoToCustomer(request, response){
    // Pick up variable from the request payload.
    let num = request.payload;

    // Check for a valid customer ID.
    if (num >= 0 && num < customer.length) {

        switch (state) {
            case stateEnum.dumping:
            case stateEnum.loading:
            case stateEnum.delivering:
                eventText = "Unable to act - " + state;
                break;

            case stateEnum.ready:
            case stateEnum.enroute:
            case stateEnum.returning:
                if (contents === contentsEnum.empty) {
                    eventText = "Unable to act - empty";
                }
                else {

                    // Set new customer event only when all is good.
                    eventText =  "New customer: " + num.toString();

                    destinationLat = customer[num][0];
                    destinationLon = customer[num][1];

                    // Find route from current position to destination, storing route.
                    GetRoute(stateEnum.enroute);
                }
                break;
        }
    }
    else {
        eventText = "Invalid customer: " + num;
    }

    // Acknowledge the command.
    response.send(200, 'Success', function (errorMessage) {
        // Failure
        if (errorMessage) {
            redMessage('Failed sending a CmdGoToCustomer response:\n' + errorMessage.message);
        }
    });
}

function ReturnToBase() {
    destinationLat = baseLat;
    destinationLon = baseLon;

    // Find route from current position to base, storing route.
    GetRoute(stateEnum.returning);
}

function CmdRecall(request, response) {

    switch (state) {
        case stateEnum.ready:
        case stateEnum.loading:
        case stateEnum.dumping:
            eventText = "Already at base";
            break;

        case stateEnum.returning:
            eventText = "Already returning";
            break;

        case stateEnum.delivering:
            eventText = "Unable to recall - " + state;
            break;

        case stateEnum.enroute:
            ReturnToBase();
            break;
    }

    // Acknowledge the command.
    response.send(200, 'Success', function (errorMessage) {
        // Failure
        if (errorMessage) {
            redMessage('Failed sending a CmdRecall response:\n' + errorMessage.message);
        }
    });
}

function dieRoll(max) {
    return Math.random() * max;
}

function UpdateTruck() {
    if (contents == contentsEnum.empty) {
        // Turn the cooling system off, if possible, when the contents are empty.
        if (fan == fanEnum.on) {
            fan = fanEnum.off;
        }
        temp += -2.9 + dieRoll(6);
    }
    else {
        // Contents are full or melting.
        if (fan != fanEnum.failed) {
            if (temp < optimalTemperature - 5) {
                // Turn the cooling system off, as contents are getting too cold.
                fan = fanEnum.off;
            }
            else {
                if (temp > optimalTemperature) {

                    // Temp getting higher, turn cooling system back on.
                    fan = fanEnum.on;
                }
            }

            // Randomly fail the cooling system.
            if (dieRoll(100) < 1) {
                fan = fanEnum.failed;
            }
        }

        // Set the contents temperature. Maintaining a cooler temperature if the cooling system is on.
        if (fan === fanEnum.on) {
            temp += -3 + dieRoll(5);
        }
        else {
            temp += -2.9 + dieRoll(6);
        }

        // If the temperature is above a threshold, count the seconds this is occurring, and melt the contents if it goes on too long.
        if (temp >= tooWarmThreshold) {
            // Contents are warming.
            tooWarmPeriod += interval;

            if (tooWarmPeriod >= tooWarmTooLong) {

                // Contents are melting.
                contents = contentsEnum.melting;
            }
        }
        else {
            // Contents are cooling.
            tooWarmPeriod = Math.max(0, tooWarmPeriod - interval);
        }
    }

    timeOnCurrentTask += interval;

    switch (state) {
        case stateEnum.loading:
            if (timeOnCurrentTask >= loadingTime) {

                // Finished loading.
                state = stateEnum.ready;
                contents = contentsEnum.full;
                timeOnCurrentTask = 0;

                // Repair/turn on the cooling fan.
                fan = fanEnum.on;
                temp = -2;
            }
            break;

        case stateEnum.ready:
            timeOnCurrentTask = 0;
            break;

        case stateEnum.delivering:
            if (timeOnCurrentTask >= deliverTime) {

                // Finished delivering.
                contents = contentsEnum.empty;
                ReturnToBase();
            }
            break;

        case stateEnum.returning:
            // Update the truck position.
            UpdatePosition();

            // Check to see if the truck has arrived back at base.
            if (Arrived()) {
                switch (contents) {

                    case contentsEnum.empty:
                        state = stateEnum.loading;
                        break;

                    case contentsEnum.full:
                        state = stateEnum.ready;
                        break;

                    case contentsEnum.melting:
                        state = stateEnum.dumping;
                        break;
                }
                timeOnCurrentTask = 0;
            }
            break;

        case stateEnum.enroute:
            // Update truck position.
            UpdatePosition();

            // Check to see if the truck has arrived at the customer.
            if (Arrived()) {
                state = stateEnum.delivering;
                timeOnCurrentTask = 0;
            }
            break;

        case stateEnum.dumping:
            if (timeOnCurrentTask >= dumpingTime) {

                // Finished dumping.
                state = stateEnum.loading;
                contents = contentsEnum.empty;
                timeOnCurrentTask = 0;
            }
            break;
    }
}

function sendTruckTelemetry() {

    // Simulate the truck.
    UpdateTruck();

    // Create the telemetry data JSON package.   
    let data = JSON.stringify(
        {
            // Format is:  
            // Name from IoT Central app ":" variable name from NodeJS app.
            ContentsTemperature: temp.toFixed(2),
            TruckState: state,
            CoolingSystemState: fan,
            ContentsState: contents,
            Location: {
                // Names must be lon, lat.
                lon: currentLon,
                lat: currentLat
            },
        });

    // Add the eventText event string, if there is one.
    if (eventText != noEvent) {
        data += JSON.stringify(
            {
                Event: eventText,
            }
        );
        eventText = noEvent;
    }

    // Create the message with the above defined data.
    let message = new Message(data);

    console.log("Message: " + data);

    // Send the message.
    client.sendEvent(message, function (errorMessage) {
        // Error
        if (errorMessage) {
            redMessage("Failed to send message to Azure IoT Central: ${err.toString()}");
        } else {
            greenMessage("Telemetry sent\n");
        }
    });
}

// Send device properties once to the IoT Central app.
function sendDeviceProperties(deviceTwin) {
    let properties =
    {
        // Format is:
        // <Property Name in Azure IoT Central> ":" <value in Node.js app>
        truckId: truckIdentification,
    };

    console.log(' * Property - truckId: ' + truckIdentification);

    deviceTwin.properties.reported.update(properties, (errorMessage) =>
        console.log(` * Sent device properties ` + (errorMessage ? `Error: ${errorMessage.toString()}` : `(success)`)));
}

// Object containing all the device settings.
let settings =
{
    // Format is:
    // '<Name from Azure IoT Central>' ":" (newvalue, callback) ....
    //  <variable name in NodeJS app> = newValue;
    //  callback(<variable name in NodeJS app>,'completed');
    'OptimalTemperature': (newValue, callback) => {
        setTimeout(() => {
            optimalTemperature = newValue;
            callback(optimalTemperature, 'completed');
        }, 1000);
    }
};

// Handle settings changes that come from Azure IoT Central via the device twin.
function handleSettings(deviceTwin) {
    deviceTwin.on('properties.desired', function (desiredChange) {
        // Iterate all settings looking for the defined one.
        for (let setting in desiredChange) {
            // Found the specified setting.
            if (settings[setting]) {
                console.log(` * Received setting: ${setting}: ${desiredChange[setting].value}`);

                // Update the setting.
                settings[setting](desiredChange[setting].value, (newValue, status, message) => {
                    let patch =
                    {
                        [setting]:
                        {
                            value: newValue,
                            status: status,
                            desiredVersion: desiredChange.$version,
                            message: message
                        }
                    }
                    deviceTwin.properties.reported.update(patch, (err) => console.log(` * Sent setting update for ${setting} ` +
                        (err ? `error: ${err.toString()}` : `(success)`)));
                });
            }
        }
    });
}

const connectCallback = (errorMessage) => {

    // Connection error.
    if (errorMessage) {
        console.log(`Device could not connect to Azure IoT Central: ${errorMessage.toString()}`);
    }

    // Successfully connected.
    else {

        // Notify the user.
        greenMessage('Device successfully connected to Azure IoT Central');

        // Send telemetry measurements to Azure IoT Central every 5 seconds.
        setInterval(sendTruckTelemetry, 5000);

        // Set up device command callbacks.
        client.onDeviceMethod('GoToCustomer', CmdGoToCustomer);
        client.onDeviceMethod('Recall', CmdRecall);

        // Get device twin from Azure IoT Central.
        client.getTwin((errMessage, deviceTwin) => {

            // Failed to retrieve device twin.
            if (errMessage) {
                redMessage(`Error getting device twin: ${errMessage.toString()}`);
            }
            else {
                // Notify the user of the successful link.
                greenMessage('Device Twin successfully retrieved from Azure IoT Central');

                // Send device properties once on device startup.
                sendDeviceProperties(deviceTwin);

                // Apply device settings and handle changes to device settings.
                handleSettings(deviceTwin);
            }
        });
    }
};

// Start the device,and connect it to Azure IoT Central.
client.open(connectCallback);