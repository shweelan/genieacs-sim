import * as net from "net";
import * as libxmljs from "libxmljs";
import * as methods from "./methods";

const NAMESPACES = {
  "soap-enc": "http://schemas.xmlsoap.org/soap/encoding/",
  "soap-env": "http://schemas.xmlsoap.org/soap/envelope/",
  xsd: "http://www.w3.org/2001/XMLSchema",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
  cwmp: "urn:dslforum-org:cwmp-1-0"
};

let nextInformTimeout = null;
let pendingInform = false;
let http = null;
let requestOptions = null;
let device = null;
let httpAgent = null;
let basicAuth;

function createSoapDocument(id) {
  const xml = new libxmljs.Document();
  const env = xml.node("soap-env:Envelope");

  for (const prefix in NAMESPACES)
    env.defineNamespace(prefix, NAMESPACES[prefix]);

  const header = env.node("soap-env:Header");

  header
    .node("cwmp:ID")
    .attr({
      "soap-env:mustUnderstand": "1"
    })
    .text(id);

  env.node("soap-env:Body");

  return xml;
}

function sendRequest(xml, callback) {
  const headers = {};
  let body = "";

  if (xml) body = xml.toString();

  headers["Content-Length"] = body.length;
  headers["Content-Type"] = 'text/xml; charset="utf-8"';
  headers["Authorization"] = basicAuth;

  if (device._cookie) headers["Cookie"] = device._cookie;

  const options = {
    method: "POST",
    headers: headers,
    agent: httpAgent
  };

  Object.assign(options, requestOptions);

  const request = http.request(options, response => {
    const chunks = [];
    let bytes = 0;

    response.on("data", chunk => {
      chunks.push(chunk);
      return (bytes += chunk.length);
    });

    return response.on("end", () => {
      let offset = 0;
      const _body = Buffer.allocUnsafe(bytes);

      chunks.forEach(chunk => {
        chunk.copy(_body, offset, 0, chunk.length);
        return (offset += chunk.length);
      });

      if (Math.floor(response.statusCode / 100) !== 2) {
        throw new Error(
          `Unexpected response Code ${response.statusCode}: ${_body}`
        );
      }

      if (+response.headers["Content-Length"] > 0 || _body.length > 0)
        xml = libxmljs.parseXml(_body.toString());
      else xml = null;

      if (response.headers["set-cookie"])
        device._cookie = response.headers["set-cookie"];

      return callback(xml);
    });
  });

  request.setTimeout(30000, () => {
    throw new Error("Socket timed out");
  });

  return request.end(body);
}

function startSession(event?: string) {
  nextInformTimeout = null;
  pendingInform = false;
  const requestId = Math.random()
    .toString(36)
    .slice(-8);
  const xmlOut = createSoapDocument(requestId);

  methods.inform(device, xmlOut, event, xml => {
    sendRequest(xml, () => {
      cpeRequest();
    });
  });
}

function createFaultResponse(xmlOut, code, message) {
  const body = xmlOut.root().childNodes()[1];

  const soapFault = body.node("soap-env:Fault");
  soapFault.node("faultcode").text("Client");
  soapFault.node("faultstring").text("CWMP fault");

  const fault = soapFault.node("detail").node("cwmp:Fault");
  fault.node("FaultCode").text(code);

  return fault.node("FaultString").text(message);
}

function cpeRequest() {
  const pending = methods.getPending();
  if (!pending) {
    sendRequest(null, xml => {
      handleMethod(xml);
    });
    return;
  }

  const requestId = Math.random()
    .toString(36)
    .slice(-8);
  const xmlOut = createSoapDocument(requestId);

  pending(xmlOut, (xml, callback) => {
    sendRequest(xml, resXML => {
      callback(resXML, cpeRequest);
    });
  });
}

function handleMethod(xml) {
  if (!xml) {
    httpAgent.destroy();
    let informInterval = 10;
    if (device["Device.ManagementServer.PeriodicInformInterval"]) {
      informInterval = parseInt(
        device["Device.ManagementServer.PeriodicInformInterval"][1]
      );
    } else if (
      device["InternetGatewayDevice.ManagementServer.PeriodicInformInterval"]
    ) {
      informInterval = parseInt(
        device[
          "InternetGatewayDevice.ManagementServer.PeriodicInformInterval"
        ][1]
      );
    }

    nextInformTimeout = setTimeout(
      () => {
        startSession();
      },
      pendingInform ? 0 : 1000 * informInterval
    );

    return;
  }

  const requestId = xml
    .get("/soap-env:Envelope/soap-env:Header/cwmp:ID", NAMESPACES)
    .text();
  const xmlOut = createSoapDocument(requestId);
  const element = xml.get(
    "/soap-env:Envelope/soap-env:Body/cwmp:*",
    NAMESPACES
  );
  const method = methods[element.name()];

  if (!method) {
    createFaultResponse(xmlOut, 9000, "Method not supported");
    sendRequest(xmlOut, resXML => {
      handleMethod(resXML);
    });
    return;
  }

  methods[element.name()](device, xml, xmlOut, reqXML => {
    sendRequest(reqXML, resXML => {
      handleMethod(resXML);
    });
  });
}

function listenForConnectionRequests(serialNumber, acsUrlOptions, callback) {
  let ip, port;
  // Start a dummy socket to get the used local ip
  const socket = net
    .createConnection({
      port: acsUrlOptions.port,
      host: acsUrlOptions.hostname,
      family: 4
    })
    .on("error", callback)
    .on("connect", () => {
      ip = socket.address()["address"];
      port = socket.address()["port"] + 1;
      socket.end();
    })
    .on("close", () => {
      const connectionRequestUrl = `http://${ip}:${port}/`;

      const httpServer = http.createServer((_req, res) => {
        // eslint-disable-next-line no-console
        console.log(`Simulator ${serialNumber} got connection request`);
        res.end();
        // A session is ongoing when nextInformTimeout === null
        if (nextInformTimeout === null) {
          pendingInform = true;
        } else {
          clearTimeout(nextInformTimeout);
          nextInformTimeout = setTimeout(() => {
            startSession("6 CONNECTION REQUEST");
          }, 0);
        }
      });

      httpServer.listen(port, ip, err => {
        if (err) return callback(err);
        // eslint-disable-next-line no-console
        console.log(
          `Simulator ${serialNumber} listening for connection requests on ${connectionRequestUrl}`
        );
        return callback(null, connectionRequestUrl);
      });
    });
}

export function start(dataModel, serialNumber, acsUrl) {
  device = dataModel;

  if (device["Device.DeviceInfo.SerialNumber"])
    device["Device.DeviceInfo.SerialNumber"][1] = serialNumber;
  else if (device["InternetGatewayDevice.DeviceInfo.SerialNumber"])
    device["InternetGatewayDevice.DeviceInfo.SerialNumber"][1] = serialNumber;

  let username = "";
  let password = "";
  if (device["Device.ManagementServer.Username"]) {
    username = device["Device.ManagementServer.Username"][1];
    password = device["Device.ManagementServer.Password"][1];
  } else if (device["InternetGatewayDevice.ManagementServer.Username"]) {
    username = device["InternetGatewayDevice.ManagementServer.Username"][1];
    password = device["InternetGatewayDevice.ManagementServer.Password"][1];
  }

  basicAuth =
    "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  requestOptions = require("url").parse(acsUrl);
  http = require(requestOptions.protocol.slice(0, -1));
  httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  listenForConnectionRequests(
    serialNumber,
    requestOptions,
    (err, connectionRequestUrl) => {
      if (err) throw err;
      if (
        device["InternetGatewayDevice.ManagementServer.ConnectionRequestURL"]
      ) {
        device[
          "InternetGatewayDevice.ManagementServer.ConnectionRequestURL"
        ][1] = connectionRequestUrl;
      } else if (device["Device.ManagementServer.ConnectionRequestURL"]) {
        device[
          "Device.ManagementServer.ConnectionRequestURL"
        ][1] = connectionRequestUrl;
      }

      startSession();
    }
  );
}
