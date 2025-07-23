"use strict";

if (!(window?.config && window?.EmCPU && window?.cpu)) throw new Error("Missing config or EmCPU or an active CPU");
const { cpu, config, EmCPU: { Device } } = window;

// Device implementation
class PS_2_Keyboard_Controller extends Device {
    constructor() {
        super("PS/2 Keyboard Controller");

        this.status = 0;
        this.data = 0;

        document.addEventListener('keydown', (ev) => {
            this.data = ev.key.charCodeAt(0);
            this.status = 1;
        });
    }

    portIn(port, size) {
        if (port === 0x64) {
            return this.status;
        }
        if (port === 0x60) {
            const data = this.data;
            this.status = 0;
            this.data = 0;
            return data;
        }
        return 0;
    }
}

// Register device
cpu.io.registerDevice([0x60, 0x64], new PS_2_Keyboard_Controller());
