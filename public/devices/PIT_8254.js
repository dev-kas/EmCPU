"use strict";

if (!(window?.config && window?.EmCPU && window?.cpu)) throw new Error("Missing config or EmCPU or an active CPU");
const { cpu, config, EmCPU: { Device, log } } = window;

// The base frequency of the PIT clock in Hz
const PIT_FREQUENCY = 1193182;

class PIT_8254 extends Device {
    constructor() {
        super("PIT 8254");
        
        this.divisor = 0;
        this.timerId = null; // To hold the ID from setInterval
        
        // The PIT expects to receive the 16-bit divisor one byte at a time.
        // This state tracks which byte we are expecting next.
        this.divisorLatch = null; // null, 'low', or 'high'
    }

    // Reading from the PIT is less common for basic OS setup, so we can ignore it for now.
    portIn(port, size) {
        return 0;
    }

    portOut(port, value, size) {
        const portId = port - 0x40;

        // Port 0x43 is the Command Port
        if (portId === 3) {
            // A typical command for setting up the timer is 0x36.
            // Bits 4-5 (0b0011....) mean "prepare to receive low byte then high byte".
            // We'll simplify and just assume this is always the case.
            if (value === 0x36) {
                // The OS is telling us it's about to send the divisor.
                // Prepare to receive the low byte first.
                this.divisorLatch = 'low';
                log("PIT: Received command 0x36. Awaiting divisor...");
            }
            return;
        }

        // Port 0x40 is the Data Port for Counter 0
        if (portId === 0 && this.divisorLatch) {
            if (this.divisorLatch === 'low') {
                // We received the low byte. Store it and wait for the high byte.
                this.divisor = value;
                this.divisorLatch = 'high';
            } else if (this.divisorLatch === 'high') {
                // We received the high byte. Combine it with the low byte.
                this.divisor |= (value << 8);
                this.divisorLatch = null; // We're done receiving.

                // Now that we have the full divisor, start the timer!
                this.startTimer();
            }
        }
    }

    startTimer() {
        // Stop any previous timer that might be running
        if (this.timerId) {
            clearInterval(this.timerId);
        }

        // A divisor of 0 means 65536 (the max 16-bit value)
        const effectiveDivisor = this.divisor === 0 ? 0x10000 : this.divisor;

        // Calculate the interval in milliseconds
        const intervalMs = (effectiveDivisor / PIT_FREQUENCY) * 1000;
        
        log(`PIT: Divisor set to ${this.divisor}. Firing IRQ 0 every ${intervalMs.toFixed(2)}ms.`);

        // --- THE HEARTBEAT ---
        this.timerId = setInterval(() => {
            // By default, IRQ 0 from the PIT is mapped to interrupt #32 on the CPU.
            cpu.raiseInterrupt(32);
            console.log("PIT: Interrupt 0 raised.")
        }, intervalMs);
    }
}

// Register the device in the IOManager
cpu.io.registerDevice([0x40, 0x41, 0x42, 0x43], new PIT_8254());