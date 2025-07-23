import { log } from "./utils.js";

export class IOManager {
    constructor() {
        this.devices = new Map();
    }

    registerDevice(ports, device) {
        const portArray = Array.isArray(ports) ? ports : [ports];
        for (const port of portArray) {
            this.devices.set(port, device);
            log(`Registered device ${device.name} at port ${port}`);
        }
    }

    portIn(port, size) {
        const device = this.devices.get(port);
        if (device && device.portIn) {
            return device.portIn(port, size);
        }
        return 0;
    }

    portOut(port, value, size) {
        const device = this.devices.get(port);
        if (device && device.portOut) {
            device.portOut(port, value, size);
        }
    }
}

export class Device {
    /**
     * @param {string} name A descriptive name for the device for logging/debugging.
     */
    constructor(name = 'Unnamed Device') {
        this.name = name;
    }

    /**
     * Handles a read from an I/O port associated with this device.
     * @param {number} port The port number being read from.
     * @param {number} size The size of the read in bytes (1, 2, or 4).
     * @returns {number} The value to be returned to the CPU.
     */
    portIn(port, size) {
        // Default behavior for a write-only or unimplemented device.
        // Real hardware often returns 0xFF on reads from empty ports, but 0 is also fine.
        return 0;
    }

    /**
     * Handles a write to an I/O port associated with this device.
     * @param {number} port The port number being written to.
     * @param {number} value The value being written by the CPU.
     * @param {number} size The size of the write in bytes (1, 2, or 4).
     */
    portOut(port, value, size) {
        // Default behavior for a read-only or unimplemented device is to do nothing.
        // This is exactly like real hardware.
    }
}
