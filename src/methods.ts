import * as http from "http";
import * as https from "https";

const NAMESPACES = {
  "soap-enc": "http://schemas.xmlsoap.org/soap/encoding/",
  "soap-env": "http://schemas.xmlsoap.org/soap/envelope/",
  xsd: "http://www.w3.org/2001/XMLSchema",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
  cwmp: "urn:dslforum-org:cwmp-1-0"
};

const INFORM_PARAMS = [
  "Device.DeviceInfo.SpecVersion",
  "InternetGatewayDevice.DeviceInfo.SpecVersion",
  "Device.DeviceInfo.HardwareVersion",
  "InternetGatewayDevice.DeviceInfo.HardwareVersion",
  "Device.DeviceInfo.SoftwareVersion",
  "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
  "Device.DeviceInfo.ProvisioningCode",
  "InternetGatewayDevice.DeviceInfo.ProvisioningCode",
  "Device.ManagementServer.ParameterKey",
  "InternetGatewayDevice.ManagementServer.ParameterKey",
  "Device.ManagementServer.ConnectionRequestURL",
  "InternetGatewayDevice.ManagementServer.ConnectionRequestURL",
  "Device.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "Device.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress"
];

export function inform(device, xmlOut, event, callback) {
  const body = xmlOut.root().childNodes()[1];
  const _inform = body.node("cwmp:Inform");
  const deviceId = _inform.node("DeviceId");

  if (device["Device.DeviceInfo.Manufacturer"]) {
    deviceId.node("Manufacturer", device["Device.DeviceInfo.Manufacturer"][1]);
  } else if (device["InternetGatewayDevice.DeviceInfo.Manufacturer"]) {
    deviceId.node(
      "Manufacturer",
      device["InternetGatewayDevice.DeviceInfo.Manufacturer"][1]
    );
  }

  if (device["Device.DeviceInfo.ManufacturerOUI"]) {
    deviceId.node("OUI", device["Device.DeviceInfo.ManufacturerOUI"][1]);
  } else if (device["InternetGatewayDevice.DeviceInfo.ManufacturerOUI"]) {
    deviceId.node(
      "OUI",
      device["InternetGatewayDevice.DeviceInfo.ManufacturerOUI"][1]
    );
  }

  if (device["Device.DeviceInfo.ProductClass"]) {
    deviceId.node("ProductClass", device["Device.DeviceInfo.ProductClass"][1]);
  } else if (device["InternetGatewayDevice.DeviceInfo.ProductClass"]) {
    deviceId.node(
      "ProductClass",
      device["InternetGatewayDevice.DeviceInfo.ProductClass"][1]
    );
  }

  if (device["Device.DeviceInfo.SerialNumber"]) {
    deviceId.node("SerialNumber", device["Device.DeviceInfo.SerialNumber"][1]);
  } else if (device["InternetGatewayDevice.DeviceInfo.SerialNumber"]) {
    deviceId.node(
      "SerialNumber",
      device["InternetGatewayDevice.DeviceInfo.SerialNumber"][1]
    );
  }

  const eventStruct = _inform
    .node("Event")
    .attr({
      "soap-enc:arrayType": "cwmp:EventStruct[1]"
    })
    .node("EventStruct");

  eventStruct.node("EventCode", event || "2 PERIODIC");
  eventStruct.node("CommandKey");

  _inform.node("MaxEnvelopes", "1");
  _inform.node("CurrentTime", new Date().toISOString());
  _inform.node("RetryCount", "0");

  const parameterList = _inform.node("ParameterList").attr({
    "soap-enc:arrayType": "cwmp:ParameterValueStruct[7]"
  });

  for (const p of INFORM_PARAMS) {
    const param = device[p];
    if (!param) continue;

    const parameterValueStruct = parameterList.node("ParameterValueStruct");
    parameterValueStruct.node("Name", p);
    parameterValueStruct.node("Value", param[1]).attr({ "xsi:type": param[2] });
  }

  callback(xmlOut);
}

const pending = [];

export function getPending() {
  return pending.shift();
}

function getSortedPaths(device) {
  if (!device._sortedPaths) {
    device._sortedPaths = Object.keys(device)
      .filter(p => p[0] !== "_")
      .sort();
  }
  return device._sortedPaths;
}

export function GetParameterNames(device, xmlIn, xmlOut, callback) {
  const parameterNames = getSortedPaths(device);
  const parameterPath = xmlIn
    .get(
      "/soap-env:Envelope/soap-env:Body/cwmp:GetParameterNames/ParameterPath",
      NAMESPACES
    )
    .text();
  const nextLevel = Boolean(
    JSON.parse(
      xmlIn
        .get(
          "/soap-env:Envelope/soap-env:Body/cwmp:GetParameterNames/NextLevel",
          NAMESPACES
        )
        .text()
    )
  );
  const parameterList = [];

  if (nextLevel) {
    for (const p of parameterNames) {
      if (p.startsWith(parameterPath) && p.length > parameterPath.length + 1) {
        const i = p.indexOf(".", parameterPath.length + 1);
        if (i === -1 || i === p.length - 1) parameterList.push(p);
      }
    }
  } else {
    for (const p of parameterNames)
      if (p.startsWith(parameterPath)) parameterList.push(p);
  }

  const getParameterNamesResponseNode = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:GetParameterNamesResponse");
  const parameterListNode = getParameterNamesResponseNode.node("ParameterList");

  parameterListNode.attr({
    "soap-enc:arrayType": `cwmp:ParameterInfoStruct[${parameterList.length}]`
  });

  for (const p of parameterList) {
    const parameterInfoStructNode = parameterListNode.node(
      "ParameterInfoStruct"
    );
    parameterInfoStructNode.node("Name", p);
    parameterInfoStructNode.node("Writable", String(device[p][0]));
  }

  return callback(xmlOut);
}

export function GetParameterValues(device, xmlIn, xmlOut, callback) {
  const parameterNames = xmlIn.find(
    "/soap-env:Envelope/soap-env:Body/cwmp:GetParameterValues/ParameterNames/*",
    NAMESPACES
  );
  const parameterList = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:GetParameterValuesResponse")
    .node("ParameterList");

  parameterList.attr({
    "soap-enc:arrayType":
      "cwmp:ParameterValueStruct[" + parameterNames.length + "]"
  });

  for (const p of parameterNames) {
    const name = p.text();
    const type = device[name][2];
    const valueStruct = parameterList.node("ParameterValueStruct");
    valueStruct.node("Name", name);
    valueStruct.node("Value", device[name][1]).attr({
      "xsi:type": type
    });
  }

  return callback(xmlOut);
}

export function SetParameterValues(device, xmlIn, xmlOut, callback) {
  const parameterValues = xmlIn.find(
    "/soap-env:Envelope/soap-env:Body/cwmp:SetParameterValues/ParameterList/*",
    NAMESPACES
  );

  for (const p of parameterValues) {
    const name = p.get("Name").text();
    const value = p.get("Value");
    device[name][1] = value.text();
    device[name][2] = value.attr("type").value();
  }

  const responseNode = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:SetParameterValuesResponse");
  responseNode.node("Status", "0");
  return callback(xmlOut);
}

export function AddObject(device, xmlIn, xmlOut, callback) {
  const objectName = xmlIn
    .get(
      "/soap-env:Envelope/soap-env:Body/cwmp:AddObject/ObjectName",
      NAMESPACES
    )
    .text();
  let instanceNumber = 1;

  while (device[`${objectName}${instanceNumber}.`]) instanceNumber += 1;

  device[`${objectName}${instanceNumber}.`] = [true];

  const defaultValues = {
    "xsd:boolean": "false",
    "xsd:int": "0",
    "xsd:unsignedInt": "0",
    "xsd:dateTime": "0001-01-01T00:00:00Z"
  };

  for (const p of getSortedPaths(device)) {
    if (p.startsWith(objectName) && p.length > objectName.length) {
      const n = `${objectName}${instanceNumber}${p.slice(
        p.indexOf(".", objectName.length)
      )}`;
      if (!device[n]) {
        device[n] = [
          device[p][0],
          defaultValues[device[p][2]] || "",
          device[p][2]
        ];
      }
    }
  }

  const responseNode = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:AddObjectResponse");
  responseNode.node("InstanceNumber", String(instanceNumber));
  responseNode.node("Status", "0");
  delete device._sortedPaths;
  return callback(xmlOut);
}

export function DeleteObject(device, xmlIn, xmlOut, callback) {
  const objectName = xmlIn
    .get(
      "/soap-env:Envelope/soap-env:Body/cwmp:DeleteObject/ObjectName",
      NAMESPACES
    )
    .text();

  for (const p in device) if (p.startsWith(objectName)) delete device[p];

  const responseNode = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:DeleteObjectResponse");
  responseNode.node("Status", "0");
  delete device._sortedPaths;
  return callback(xmlOut);
}

export function Download(device, xmlIn, xmlOut, callback) {
  const commandKey = xmlIn
    .get(
      "/soap-env:Envelope/soap-env:Body/cwmp:Download/CommandKey",
      NAMESPACES
    )
    .text();
  const url = xmlIn
    .get("/soap-env:Envelope/soap-env:Body/cwmp:Download/URL", NAMESPACES)
    .text();

  let faultCode = "9010";
  let faultString = "Download timeout";

  if (url.startsWith("http://")) {
    http
      .get(url, res => {
        res.on("end", () => {
          if (res.statusCode === 200) {
            faultCode = "0";
            faultString = "";
          } else {
            faultCode = "9016";
            faultString = `Unexpected response ${res.statusCode}`;
          }
        });
        res.resume();
      })
      .on("error", err => {
        faultString = err.message;
      });
  } else if (url.startsWith("https://")) {
    https
      .get(url, res => {
        res.on("end", () => {
          if (res.statusCode === 200) {
            faultCode = "0";
            faultString = "";
          } else {
            faultCode = "9016";
            faultString = `Unexpected response ${res.statusCode}`;
          }
        });
        res.resume();
      })
      .on("error", err => {
        faultString = err.message;
      });
  }

  const startTime = new Date();
  pending.push((_xmlOut, cb) => {
    const requestNode = _xmlOut
      .root()
      .childNodes()[1]
      .node("cwmp:TransferComplete");
    requestNode.node("CommandKey", commandKey);
    requestNode.node("StartTime", startTime.toISOString());
    requestNode.node("CompleteTime", new Date().toISOString());
    const fault = requestNode.node("FaultStruct");
    fault.node("FaultCode").text(faultCode);
    fault.node("FaultString").text(faultString);

    cb(_xmlOut, (xml, _cb) => {
      _cb();
    });
  });

  const responseNode = xmlOut
    .root()
    .childNodes()[1]
    .node("cwmp:DownloadResponse");
  responseNode.node("Status", "1");
  responseNode.node("StartTime", "0001-01-01T00:00:00Z");
  responseNode.node("CompleteTime", "0001-01-01T00:00:00Z");

  return callback(xmlOut);
}
