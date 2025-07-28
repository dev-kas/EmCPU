// /public/devices/PIT_8254.js
"use strict";

if (!(window?.config && window?.EmCPU && window?.cpu)) throw new Error("Missing config or EmCPU or an active CPU");
const { cpu, config, EmCPU: { Device, log } } = window;

const PIT_FREQUENCY = 1193182; // The PIT's base clock frequency in Hz

class PIT_8254 extends Device {
    constructor() {
        super("PIT 8254");
        this.divisor = 0;
        this.timerId = null;
        this.divisorLatch = null; // Tracks if we're waiting for the low or high byte
    }

    portOut(port, value, size) {
        if (port === 0x43) { // Command Port
            // A command of 0x36 means "Counter 0, LSB then MSB, Rate Generator Mode"
            if (value === 0x36) {
                this.divisorLatch = 'low';
                log("PIT: Awaiting divisor for Counter 0...");
            }
        } else if (port === 0x40 && this.divisorLatch) { // Data Port for Counter 0
            if (this.divisorLatch === 'low') {
                this.divisor = value;
                this.divisorLatch = 'high';
            } else if (this.divisorLatch === 'high') {
                this.divisor |= (value << 8);
                this.divisorLatch = null; // Done receiving
                this.startTimer();
            }
        }
    }

    startTimer() {
        if (this.timerId) {
            clearInterval(this.timerId);
        }
        const effectiveDivisor = this.divisor === 0 ? 0x10000 : this.divisor;
        const intervalMs = (effectiveDivisor / PIT_FREQUENCY) * 1000;
        
        log(`PIT: Starting timer. IRQ 0 will fire every ${intervalMs.toFixed(2)}ms.`);

        this.timerId = setInterval(() => {
            // The PIT is wired to IRQ 0, which is mapped to interrupt #32.
            cpu.raiseInterrupt(32);
        }, intervalMs);
    }
}

// Register the device with the machine
cpu.io.registerDevice([0x40, 0x43], new PIT_8254());