import fs from 'fs';
import readline from 'readline';

export class IOManager {
    constructor() {
        this.devices = new Map();
    }

    registerDevice(ports, device) {
        const portArray = Array.isArray(ports) ? ports : [ports];
        for (const port of portArray) {
            this.devices.set(port, device);
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

export class SerialPort {
    // We only care about writing characters out
    portOut(port, value, size) {
        // The data register for the first serial port is 0x3F8
        if (port === 0x3F8 && size === 1) {
            // This is the magic: print the character to the host's console
            fs.appendFileSync('out/serial.log', String.fromCharCode(value));
        }
    }
}

export class KeyboardController {
    constructor() {
        this.status = 0; // The status register
        this.data = 0;   // The data register

        // This is the magic to capture host keypresses
        if (process.stdin.isTTY) {
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.on('keypress', (str, key) => {
                // When a key is pressed, store its scancode and update the status
                // A very simplified scancode mapping (e.g., 'a' -> 0x1E)
                // For now, let's just use the ASCII value for simplicity
                if (str) {
                    this.data = str.charCodeAt(0);
                    this.status = 1; // Set bit 0: "output buffer full"
                }

                // Handle Ctrl+C to exit the emulator
                if (key && key.ctrl && key.name === 'c') {
                    process.exit();
                }
            });
            console.log("Keyboard initialized. Press Ctrl+C to exit.");
        }
    }

    portIn(port, size) {
        if (port === 0x64) { // Reading the Status Port
            return this.status;
        }
        if (port === 0x60) { // Reading the Data Port
            const data = this.data;
            this.status = 0; // Once read, the buffer is now empty
            this.data = 0;
            return data;
        }
        return 0;
    }
}
