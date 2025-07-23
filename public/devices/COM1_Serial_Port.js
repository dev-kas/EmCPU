"use strict";

if (!(window?.config && window?.EmCPU && window?.cpu)) throw new Error("Missing config or EmCPU or an active CPU");
const { cpu, config, EmCPU: { Device } } = window;

// Device implementation
class COM1_Serial_Port extends Device {
    constructor() {
        super("COM1 Serial Port");

        // Create or use an existing COM1 Serial Port's textarea
        this.element = document.getElementById("com1_serial_port");
        if (!this.element) {
            this.element = document.createElement("textarea");
            this.element.id = "com1_serial_port";
            this.element.rows = 10;
            this.element.cols = 80;
            document.body.appendChild(this.element);
        }

        this.buffer = "";
    }

    portOut(port, value, size) {
        if (port === 0x3F8 && size === 1) {
            this.buffer += String.fromCharCode(value);
            this.element.value = this.buffer;
        }
    }
}

// Register device
cpu.io.registerDevice(0x3F8, new COM1_Serial_Port());
