import CoreBluetooth
import Foundation

// One JSON object per line; stdout is reserved for replies and events.
private func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

final class MicrobitBLE: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let uart = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private let channels = ["6E400002", "6E400003"].map { CBUUID(string: $0 + "-B5A3-F393-E0A9-E50E24DCCA9E") }
    private var central: CBCentralManager!
    private var scanRequest: Int?
    private var scanDeadline: DispatchTime = .now()
    private var stateCheckRequest: Int?
    private var unauthorizedSince: DispatchTime?
    private var refreshedAfterGrant = false
    private var lastStateMessage: String?
    private var showAll = false
    private var found: [UUID: CBPeripheral] = [:]
    private var names: [UUID: String] = [:]
    private var peripheral: CBPeripheral?
    private var connectRequest: Int?
    private var incoming: CBCharacteristic?
    private var notifyCandidates: [CBCharacteristic] = []
    private var uartCharacteristics: [CBCharacteristic] = []
    private var outgoing: CBCharacteristic?
    private var writeRequest: Int?

    private func reply(_ id: Int, _ result: [String: Any] = [:]) {
        send(["id": id, "ok": true, "result": result])
    }

    private func fail(_ id: Int, _ error: String, _ name: String = "NetworkError") {
        send(["id": id, "ok": false, "error": error, "name": name])
    }

    func command(_ line: String) {
        guard let msg = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let id = msg["id"] as? Int, let op = msg["op"] as? String else { return }
        switch op {
        case "ping":
            reply(id, ["backend": "Core Bluetooth"])
        case "scan":
            guard peripheral == nil else { return fail(id, "Disconnect before scanning.") }
            stopScan()
            found.removeAll()
            names.removeAll()
            showAll = msg["all"] as? Bool ?? false
            scanRequest = id
            scanDeadline = .now() + 60
            unauthorizedSince = nil
            refreshedAfterGrant = false
            lastStateMessage = nil
            if central == nil || central.state == .unauthorized {
                recreateManager()
                checkStateSoon(id)
            } else {
                updateState()
            }
        case "stop":
            stopScan()
            reply(id)
        case "connect":
            guard central?.state == .poweredOn,
                  let key = (msg["deviceId"] as? String).flatMap(UUID.init(uuidString:)),
                  let selected = found[key], peripheral == nil else {
                return fail(id, "The selected device or Bluetooth adapter is unavailable.")
            }
            stopScan()
            peripheral = selected
            connectRequest = id
            selected.delegate = self
            central.connect(selected)
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                if self?.connectRequest == id {
                    self?.endConnection("Timed out connecting to the micro:bit.")
                }
            }
        case "disconnect":
            endConnection("Disconnected.", reportLoss: false)
            reply(id)
        case "write":
            guard let p = peripheral, let characteristic = outgoing, writeRequest == nil,
                  let encoded = msg["data"] as? String, let data = Data(base64Encoded: encoded),
                  !data.isEmpty, data.count <= 20 else { return fail(id, "UART is not ready for this write.") }
            if characteristic.properties.contains(.writeWithoutResponse) && p.canSendWriteWithoutResponse {
                p.writeValue(data, for: characteristic, type: .withoutResponse)
                reply(id)
            } else if characteristic.properties.contains(.write) {
                writeRequest = id
                p.writeValue(data, for: characteristic, type: .withResponse)
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                    if self?.writeRequest == id {
                        self?.endConnection("Timed out writing to the micro:bit.")
                    }
                }
            } else {
                fail(id, "The micro:bit is busy receiving data.")
            }
        default:
            fail(id, "Unknown Bluetooth command.")
        }
    }

    private func stopScan() {
        if central?.isScanning == true { central.stopScan() }
        if let id = scanRequest {
            scanRequest = nil
            fail(id, "Scan cancelled.", "AbortError")
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central === self.central else { return }
        updateState()
    }

    private func recreateManager() {
        central?.delegate = nil
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }

    private func checkStateSoon(_ id: Int) {
        guard stateCheckRequest != id else { return }
        stateCheckRequest = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, self.stateCheckRequest == id else { return }
            self.stateCheckRequest = nil
            if self.scanRequest == id { self.updateState() }
        }
    }

    private func updateState() {
        let state: String
        switch central.state {
        case .poweredOn: state = "powered on"
        case .poweredOff: state = "powered off"
        case .unauthorized: state = "access denied"
        case .unsupported: state = "unsupported"
        case .resetting: state = "resetting"
        default: state = "initializing"
        }
        let authorization = CBManager.authorization
        let permission: String
        switch authorization {
        case .allowedAlways: permission = "allowed"
        case .denied: permission = "denied"
        case .restricted: permission = "restricted"
        case .notDetermined: permission = "waiting for a decision"
        @unknown default: permission = "unknown"
        }
        let message = "Core Bluetooth: adapter \(state); permission \(permission)."
        if message != lastStateMessage {
            lastStateMessage = message
            send(["event": "state", "message": message])
        }
        if central.state == .poweredOn {
            if let id = scanRequest {
                scanRequest = nil
                central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
                reply(id)
                emitDevices()
            }
            return
        }
        if let id = scanRequest {
            let now = DispatchTime.now()
            if now >= scanDeadline {
                scanRequest = nil
                return fail(id, "Core Bluetooth did not become ready within 60 seconds. \(message)", "TimeoutError")
            }
            if central.state == .unknown || central.state == .resetting ||
                (central.state == .unauthorized && authorization == .notDetermined) {
                checkStateSoon(id)
                return
            }
            if central.state == .unauthorized && authorization == .allowedAlways && !refreshedAfterGrant {
                refreshedAfterGrant = true
                unauthorizedSince = nil
                recreateManager()
                checkStateSoon(id)
                return
            }
            if central.state == .unauthorized && authorization != .restricted {
                let first = unauthorizedSince ?? now
                unauthorizedSince = first
                if now < first + 3 {
                    checkStateSoon(id)
                    return
                }
            }
        } else if central.state == .unknown || central.state == .resetting {
            return
        }
        let error = central.state == .unauthorized
            ? "macOS did not authorize this copy of the bridge. \(message) Check Privacy & Security → Bluetooth, then quit and reopen the bridge."
            : "The Mac’s Bluetooth adapter is \(state)."
        if let id = scanRequest {
            scanRequest = nil
            fail(id, error, central.state == .unauthorized ? "NotAllowedError" : "NetworkError")
        }
        if peripheral != nil { endConnection(error) }
        send(["event": "unavailable", "message": error])
    }

    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        guard central.isScanning else { return }
        let advertised = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = [advertised, p.name].compactMap { $0 }.first { $0.hasPrefix("BBC micro:bit") }
            ?? advertised ?? p.name ?? names[p.identifier] ?? "(unnamed)"
        guard showAll || name.hasPrefix("BBC micro:bit") else { return }
        found[p.identifier] = p
        guard names[p.identifier] != name else { return }
        names[p.identifier] = name
        emitDevices()
    }

    private func emitDevices() {
        let devices = names.sorted { ($0.value, $0.key.uuidString) < ($1.value, $1.key.uuidString) }
            .map { ["deviceId": $0.key.uuidString, "deviceName": $0.value] }
        send(["event": "devices", "devices": devices])
    }

    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral, connectRequest != nil else { return }
        p.discoverServices([uart])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        endConnection(error?.localizedDescription ?? "The micro:bit could not connect.")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        endConnection(error?.localizedDescription ?? "The micro:bit disconnected.")
    }

    private func endConnection(_ reason: String, name: String = "NetworkError", reportLoss: Bool = true) {
        let established = incoming?.isNotifying == true && connectRequest == nil
        let p = peripheral
        peripheral = nil
        incoming = nil
        outgoing = nil
        notifyCandidates.removeAll()
        uartCharacteristics.removeAll()
        if let p = p {
            p.delegate = nil
            if central.state == .poweredOn && p.state != .disconnected {
                central.cancelPeripheralConnection(p)
            }
        }
        if let id = connectRequest {
            connectRequest = nil
            fail(id, reason, name)
        } else if reportLoss && (established || p != nil) {
            send(["event": "disconnected", "message": reason])
        }
        if let id = writeRequest {
            writeRequest = nil
            fail(id, reason)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral, connectRequest != nil else { return }
        if let error = error { return endConnection(error.localizedDescription) }
        guard let service = p.services?.first(where: { $0.uuid == uart }) else {
            return endConnection("The UART service was not found.", name: "NotFoundError")
        }
        p.discoverCharacteristics(channels, for: service)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral, connectRequest != nil else { return }
        if let error = error { return endConnection(error.localizedDescription) }
        uartCharacteristics = service.characteristics ?? []
        notifyCandidates = uartCharacteristics.filter {
            $0.properties.contains(.notify) || $0.properties.contains(.indicate)
        }
        trySubscribe(p)
    }

    private func trySubscribe(_ p: CBPeripheral) {
        guard !notifyCandidates.isEmpty else { return endConnection("Neither UART characteristic accepted notifications.") }
        let characteristic = notifyCandidates.removeFirst()
        incoming = characteristic
        p.setNotifyValue(true, for: characteristic)
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard p === peripheral, characteristic === incoming, let id = connectRequest else { return }
        guard error == nil && characteristic.isNotifying else { return trySubscribe(p) }
        outgoing = uartCharacteristics.first {
            $0 !== characteristic && ($0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse))
        }
        connectRequest = nil
        reply(id, ["canWrite": outgoing != nil])
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard p === peripheral, characteristic === incoming, connectRequest == nil,
              error == nil, let data = characteristic.value else { return }
        send(["event": "data", "data": data.base64EncodedString()])
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard p === peripheral, characteristic === outgoing, let id = writeRequest else { return }
        writeRequest = nil
        if let error = error { fail(id, error.localizedDescription) } else { reply(id) }
    }
}

let ble = MicrobitBLE()
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async { ble.command(line) }
    }
    // Schedule shutdown after queued replies so a pipe can also test the helper.
    DispatchQueue.main.async { exit(EXIT_SUCCESS) }
}
dispatchMain()
