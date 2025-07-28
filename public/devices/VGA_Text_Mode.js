// /public/devices/VGA_Text_Mode.js
"use strict";

if (!(window?.config && window?.EmCPU && window?.cpu)) throw new Error("Missing config or EmCPU or an active CPU");
const { cpu, EmCPU: { Device } } = window;

class VGATextMode extends Device {
    constructor() {
        super("VGA Text Mode");
        this.element = document.createElement("pre");
        this.element.style.cssText = `
            background-color: #000;
            color: #AAA;
            font-family: 'Courier New', Courier, monospace;
            font-size: 16px;
            line-height: 1.2;
            white-space: pre;
            width: calc(80ch);
            height: calc(25 * 1.2em);
            padding: 10px;
        `;
        document.body.appendChild(this.element);

        this.width = 80;
        this.height = 25;
        // Create a buffer to hold the character data
        this.screenBuffer = new Array(this.width * this.height).fill(0x0720); // Gray on Black, space character
        this.updateScreen();
    }

    // This device works with MEMORY, not I/O ports.
    // So we don't use portIn/portOut.
    // Instead, the main emulator will call this.
    write(address, value, size) {
        // We only care about 16-bit (word) writes
        if (size === 2) {
            const offset = address - 0xb8000;
            const index = offset / 2;
            if (index >= 0 && index < this.screenBuffer.length) {
                this.screenBuffer[index] = value;
                this.updateScreen();
            }
        }
    }

    updateScreen() {
        let text = "";
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const charCode = this.screenBuffer[y * this.width + x] & 0xFF;
                text += String.fromCharCode(charCode);
            }
            text += '\n';
        }
        this.element.textContent = text;
    }
}

// --- Hooking into the Memory System ---
// We need to tell the main memory object to delegate writes
// to this region to our new device.
const vga = new VGATextMode();
const originalWrite = cpu.memory.writeUint16.bind(cpu.memory);

cpu.memory.writeUint16 = (address, value) => {
    if (address >= 0xb8000 && address < 0xb8000 + 80 * 25 * 2) {
        vga.write(address, value, 2);
    } else {
        originalWrite(address, value);
    }
};
