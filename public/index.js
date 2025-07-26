"use strict";

if (!window?.config || !window?.EmCPU) {
    throw new Error("Missing config or EmCPU");
}

const { Debugger } = await import("./debugger.js");

EmCPU.setMode("prod");
// --- Boot Sector ---
let bootsector;
{
    const res = await fetch("/out/boot.bin");
    if (!res.ok) throw new Error("Failed to fetch boot sector: " + res.statusText);
    const buf = await res.arrayBuffer();
    bootsector = new Uint8Array(buf);
}

// --- Initialize CPU, Memory, IO ---
const memory = new EmCPU.Memory(window.config.MEM_SIZE);
const io = new EmCPU.IOManager();
const cpu = new EmCPU.CPU(memory, io);
window.cpu = cpu;

// --- Devices ---
await import("./devices/COM1_Serial_Port.js");
await import("./devices/PS_2_Keyboard_Controller.js");
// await import("./devices/PIT_8254.js");

// --- Paging + Bootsector ---
cpu.cr3 = EmCPU.CPU.setupIdentityPaging(memory, 0n, 0n, 0x200000n, 0x200000n);
memory.load(0x7C00, bootsector);
cpu.rip = 0x7C00n;

// --- Debugger ---
const dbgr = new Debugger(cpu);
if (
    window.location.search.includes("debug") ||
    window.localStorage && window.localStorage.getItem("debug") === "true" ||
    window.sessionStorage && window.sessionStorage.getItem("debug") === "true" ||
    window.location.hash.includes("debug")
) dbgr.init(document.body);

// --- Utility: Dump Final CPU State ---
function printFinalState(cpu) {
    const hex = (val, bits = 64) => `0x${(BigInt(val) & ((1n << BigInt(bits)) - 1n)).toString(16).padStart(bits / 4, '0')}`;
    console.log("\n--- Final State ---");
    ["rax", "rbx", "rcx", "rdx", "rdi", "r8"].forEach(r => {
        console.log(`${r.toUpperCase()}:`, hex(cpu[r]));
    });
    console.log("AL:", hex(cpu.readRegister('al', 1), 8));
    console.log("CR0:", hex(cpu.cr0));
    console.log("CR3:", hex(cpu.cr3));
    console.log("CR4:", hex(cpu.cr4));
    console.log("EFER:", hex(cpu.efer));
    console.log("Flags:", cpu.flags);
}

// --- Main Emulation Loop ---
let stepsPerChunk = 500;
const timeBudget = 5; // ms
let lastRender = performance.now();
let lastMeasuredStepTime = 0;
let lastMeasuredSteps = 0;

async function run() {
    try {
        while (true) {
            
            const start = performance.now();
            let steps = 0;
            
            while ((performance.now() - start) < timeBudget && steps < stepsPerChunk) {
                await dbgr.tick(); // Wait for user to allow execution
                if (!cpu.step()) {
                    printFinalState(cpu); // HLT
                    return;
                }

                if (cpu.rip >= BigInt(window.config.MEM_SIZE)) {
                    console.error("RIP out of bounds");
                    printFinalState(cpu);
                    // dbgr.tick(); // Show final state
                    return;
                }

                steps++;
            }

            const elapsed = performance.now() - start;
            lastMeasuredStepTime = elapsed;
            lastMeasuredSteps = steps;

            await new Promise(requestAnimationFrame); // yield to UI
        }
    } catch (err) {
        console.error("Fatal error:", err);
        printFinalState(cpu);
        // dbgr.tick(); // Show final state
    }
}

// --- Autotune Performance ---
let smoothing = 0.3;
let avgElapsed = null;

setInterval(() => {
    if (lastMeasuredStepTime === 0) return;

    if (avgElapsed === null) {
        avgElapsed = lastMeasuredStepTime;
    } else {
        avgElapsed = smoothing * lastMeasuredStepTime + (1 - smoothing) * avgElapsed;
    }

    if (avgElapsed < timeBudget - 1) {
        stepsPerChunk += 100;
    } else if (avgElapsed > timeBudget + 1) {
        stepsPerChunk = Math.max(100, stepsPerChunk - 100);
    }

    // EmCPU.log(`AutoTuned stepsPerChunk = ${stepsPerChunk} (avg: ${avgElapsed.toFixed(2)}ms)`);
}, 1000);

console.log("--- STARTING EMULATION ---");
run();
