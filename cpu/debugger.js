import readline from 'readline';

export class Debugger {
    constructor(cpu, memory) {
        this.cpu = cpu;
        this.memory = memory;
        this.breakpoints = new Set();
        this.stepMode = true;
        this.lastCommand = '';
    }

    async prompt() {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                historySize: 50,
                completer: (line) => {
                    const cmds = ['next', 'n', 'continue', 'c', 'regs', 'rip', 'flags', 'mem', 'dump', 'break', 'bl', 'bc', 'inst', 'quit', 'exit', 'help'];
                    const hits = cmds.filter(c => c.startsWith(line));
                    return [hits.length ? hits : cmds, line];
                }
            });

            rl.question("dbg> ", (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    async runShell() {
        while (true) {
            let cmdline = await this.prompt();
            if (!cmdline && this.lastCommand) {
                cmdline = this.lastCommand;
            }

            const [commandRaw, ...args] = cmdline.split(/\s+/);
            const command = commandRaw.toLowerCase();
            this.lastCommand = cmdline;

            try {
                switch (command) {
                    case 'next':
                    case 'n':
                        this.stepMode = true;
                        return true;

                    case 'continue':
                    case 'c':
                        this.stepMode = false;
                        return true;

                    case 'regs':
                        this.dumpRegisters();
                        break;

                    case 'flags':
                        console.log("Flags (CF ZF SF OF):", this.cpu.flags);
                        break;

                    case 'rip':
                        console.log("RIP:", this.hex(this.cpu.rip));
                        break;

                    case 'mem':
                        this.showMemory(args);
                        break;

                    case 'dump':
                        this.dumpMemoryRange(args);
                        break;

                    case 'break':
                        this.setBreakpoint(args);
                        break;

                    case 'bl':
                        this.listBreakpoints();
                        break;

                    case 'bc':
                        this.clearBreakpoint(args);
                        break;

                    case 'inst':
                        this.showInstructionPreview();
                        break;

                    case 'exit':
                    case 'quit':
                        process.exit(0);

                    case 'help':
                        this.showHelp();
                        break;

                    default:
                        console.log("Unknown command. Type `help` for list of commands.");
                }
            } catch (err) {
                console.log("Error:", err.message);
            }
        }
    }

    dumpRegisters() {
        const r = this.cpu;
        const f = (v, b = 64) => '0x' + BigInt(v).toString(16).padStart(b / 4, '0');
        console.log("General:");
        console.log("RAX:", f(r.rax), "RBX:", f(r.rbx), "RCX:", f(r.rcx), "RDX:", f(r.rdx));
        console.log("RSI:", f(r.rsi), "RDI:", f(r.rdi), "RSP:", f(r.rsp), "RBP:", f(r.rbp));
        console.log("RIP:", f(r.rip));
        console.log("Extended:");
        console.log("R8:", f(r.r8), "R9:", f(r.r9), "R10:", f(r.r10));
        console.log("Control:");
        console.log("CR0:", f(r.cr0), "CR3:", f(r.cr3), "CR4:", f(r.cr4), "EFER:", f(r.efer));
    }

    showMemory(args) {
        const addr = BigInt(args[0]);
        const bytes = this.memory.readBigUint64(Number(addr), 8);
        const hexStr = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`${this.hex(addr)}: ${hexStr}`);
    }

    dumpMemoryRange(args) {
        const addr = BigInt(args[0]);
        const len = parseInt(args[1] || '32', 10);
        const bytes = this.memory.readBigUint64(Number(addr), len);

        for (let i = 0; i < len; i += 16) {
            const chunk = bytes.slice(i, i + 16);
            const hexStr = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`${this.hex(addr + BigInt(i))}: ${hexStr}`);
        }
    }

    setBreakpoint(args) {
        const addr = BigInt(args[0]);
        if (this.breakpoints.has(addr)) {
            console.log(`Breakpoint already exists at ${this.hex(addr)}`);
        } else {
            this.breakpoints.add(addr);
            console.log(`Breakpoint set at ${this.hex(addr)}`);
        }
    }

    listBreakpoints() {
        if (!this.breakpoints.size) {
            console.log("No breakpoints.");
            return;
        }
        console.log("Breakpoints:");
        for (const addr of this.breakpoints) {
            console.log(`- ${this.hex(addr)}`);
        }
    }

    clearBreakpoint(args) {
        const addr = BigInt(args[0]);
        if (this.breakpoints.delete(addr)) {
            console.log(`Breakpoint removed at ${this.hex(addr)}`);
        } else {
            console.log(`No breakpoint found at ${this.hex(addr)}`);
        }
    }

    showInstructionPreview() {
        const rip = Number(this.cpu.rip);
        const opBytes = this.memory.readBytes(rip, 8);
        const hexStr = Array.from(opBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`Instruction @ ${this.hex(this.cpu.rip)}: ${hexStr}`);
        // Future: Use a real disassembler here (like Capstone or custom decode).
    }

    showHelp() {
        console.log(`
Available Commands:
  n, next              Step to next instruction
  c, continue          Continue execution until next breakpoint
  regs                 Show general-purpose and control registers
  flags                Show CPU flags
  rip                  Show current instruction pointer
  mem <addr>           Show 8 bytes at address
  dump <addr> <len>    Dump memory from <addr> for <len> bytes
  break <addr>         Set breakpoint at address
  bl                   List all breakpoints
  bc <addr>            Clear breakpoint at address
  inst                 Show bytes of instruction at RIP
  help                 Show this help message
  quit, exit           Exit debugger
`);
    }

    hex(v, b = 64) {
        return '0x' + BigInt(v).toString(16).padStart(b / 4, '0');
    }
}
