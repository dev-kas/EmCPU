import * as utils from "./utils.js";

export class Memory {
    constructor(size) {
        this.buffer = new ArrayBuffer(size);
        this.view = new DataView(this.buffer);
        new Uint8Array(this.buffer).fill(0); 
    }

    // Read methods
    readUint8(addr) { return this.view.getUint8(addr); }
    readUint16(addr) { return this.view.getUint16(addr, true); } // true for little-endian
    readUint32(addr) { return this.view.getUint32(addr, true); }
    readBigUint64(addr) { return this.view.getBigUint64(addr, true); }

    // Write methods
    writeUint8(addr, value) { this.view.setUint8(addr, Number(value)); }
    writeUint16(addr, value) { this.view.setUint16(addr, Number(value), true); } // true for little-endian
    writeUint32(addr, value) { this.view.setUint32(addr, Number(value), true); }
    writeBigUint64(addr, value) { this.view.setBigUint64(addr, value, true); }

    // Helper to load binary data into memory (eg. boot sector)
    load(addr, data) {
        const sourceUint8Array = new Uint8Array(data);
        const mainBufferView = new Uint8Array(this.buffer);

        if (Number(addr) < 0 || (Number(addr) + sourceUint8Array.byteLength) > mainBufferView.byteLength) {
            throw new Error(`Memory.load: Attempted to load 0x${sourceUint8Array.byteLength.toString(16)} bytes at 0x${addr.toString(16)} which is outside the allocated memory bounds (0x0 to 0x${mainBufferView.byteLength.toString(16)}).`);
        }

        mainBufferView.set(sourceUint8Array, Number(addr));
        utils.log(`Memory.load: Loaded 0x${sourceUint8Array.byteLength.toString(16)} bytes to 0x${addr.toString(16)}`);
    }
}