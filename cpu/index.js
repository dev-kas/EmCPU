import { CPU } from "./cpu.js";
import { Memory } from "./memory.js";
import { Debugger } from "./debugger.js";
import { IOManager, SerialPort, KeyboardController } from "./io.js";
import fs from 'fs';

// Helper function from your original code
const formatRegister = (value, bits = 64) => {
    const bigVal = BigInt(value);
    const mask = (1n << BigInt(bits)) - 1n;
    const maskedValue = bigVal & mask;
    const hexStr = maskedValue.toString(16).padStart(bits / 4, '0');
    return `0x${hexStr}`;
};

// Moved the final state dump into its own function for clarity
function printFinalState(cpu, memory) {
    console.log("\nEmulation completed");
    console.log("--- Final Register States ---");
    console.log("Final AL:", formatRegister(cpu.readRegister('al', 1), 8));
    console.log("Final RAX:", formatRegister(cpu.rax));
    console.log("Final RBX:", formatRegister(cpu.rbx));
    console.log("Final RCX:", formatRegister(cpu.rcx));
    console.log("Final RDX:", formatRegister(cpu.rdx));
    console.log("Final R8:", formatRegister(cpu.r8));
    console.log("Final RDI:", formatRegister(cpu.rdi));

    console.log("\n--- Final Control Registers ---");
    console.log("Final CR0:", `0x${cpu.cr0.toString(16).padStart(16, '0')}`);
    console.log("Final CR3:", `0x${cpu.cr3.toString(16).padStart(16, '0')}`);
    console.log("Final CR4:", `0x${cpu.cr4.toString(16).padStart(16, '0')}`);
    console.log("Final EFER:", `0x${cpu.efer.toString(16).padStart(16, '0')}`);

    console.log("\n--- Final Flags ---");
    console.log("Final Flags (CF, ZF, SF, OF):", cpu.flags);

    console.log("\n--- Memory Verification ---");
    const actualWrittenAddress = 0x201aan; 
    console.log(`Memory at 0x${actualWrittenAddress.toString(16)}: 0x${memory.readBigUint64(Number(actualWrittenAddress)).toString(16)}`);

    // We must explicitly exit because the keyboard listener keeps the process alive.
    process.exit(0);
}

async function runEmulator() {
    const memSize = 1024 * 1024 * 64;
    const memory = new Memory(memSize);
    const io = new IOManager();
    const cpu = new CPU(memory, io);
    const debuggerInstance = new Debugger(cpu, memory);

    // --- Setup Devices ---
    const serial = new SerialPort();
    io.registerDevice(0x3F8, serial);
    const keyboard = new KeyboardController();
    io.registerDevice([0x60, 0x64], keyboard);

    // --- Initial Memory/CPU State ---
    memory.writeBigUint64(0x10020, 0xAABBCCDDEEFF0011n);
    console.log("Memory initialised at 0x10020 with: 0xAABBCCDDEEFF0011n");
    
    // --- Setup Paging ---
    const pml4PhysAddr = CPU.setupIdentityPaging(memory, 0n, 0n, 0x200000n, 0x200000n);
    cpu.cr3 = pml4PhysAddr;

    // --- Load Boot Sector ---
    const bootSectorData = new Uint8Array(fs.readFileSync('out/boot.bin'));
    memory.load(0x7C00, bootSectorData);
    cpu.rip = 0x7C00n;

    // --- The Asynchronous Main Loop ---
    const run_loop = async () => {
        try {
            // Check for debugger break condition
            if (debuggerInstance.breakpoints.has(cpu.rip) || debuggerInstance.stepMode) {
                // await debuggerInstance.runShell();
            }

            // Execute one CPU instruction
            const isRunning = cpu.step();

            if (isRunning) {
                // Check for segmentation fault
                if (cpu.rip >= BigInt(memSize)) {
                    console.error("Segmentation fault");
                    printFinalState(cpu, memory); // Print state and exit
                } else {
                    // Schedule the next iteration, yielding to the event loop
                    setImmediate(run_loop);
                }
            } else {
                // HLT was executed, emulation is finished
                printFinalState(cpu, memory);
            }
        } catch (e) {
            console.error("A fatal error occurred during emulation:", e);
            printFinalState(cpu, memory);
        }
    };

    // --- Start Emulation ---
    console.log("Starting emulation...");
    run_loop(); // Kick off the main loop
}

runEmulator();