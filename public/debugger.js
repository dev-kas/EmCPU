if (!window?.config || !window?.EmCPU) {
    throw new Error("Missing config or EmCPU");
}

export class Debugger {
    constructor(cpu) {
        this.cpu = cpu;

        this.didInit = false;

        this.elem = null;
        this.regView = null;
        this.flagsView = null;
        this.memView = null;
        this.logsView = null;
        this.stateText = null;
        this.ripText = null;

        this._state = "stopped";

        this.prevRegisters = {};
        this.prevFlags = {};
        this.prevMemory = new Uint8Array(cpu.memory.buffer.byteLength);

        this.brkPoints = new Set();
    }

    get state() {
        return this._state;
    }

    set state(value) {
        this._state = value;
        if (!this.didInit) return;
        this.stateText.textContent = `(${this.state})`;
    }

    init(parent = document.body) {
        if (this.didInit) return;

        const elem = document.createElement("div");
        elem.style.cssText = `
            position: fixed;
            top: 0;
            right: 0;
            background-color: #333;
            color: white;
            padding: 10px;
            z-index: 1000;
            font-family: monospace;
            height: max-content;
            width: max-content;
            box-sizing: border-box;
        `;

        // Header
        const header = document.createElement("div");
        header.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
        
        const headerText = document.createElement("span");
        headerText.textContent = "EmCPU Debugger";
        headerText.style.cssText = "font-size: 16px; font-weight: bold;";
        header.appendChild(headerText);

        const stateText = document.createElement("span");
        stateText.textContent = `(${this.state})`;
        stateText.style.cssText = "font-size: 16px; color: #666;";
        header.appendChild(stateText);
        this.stateText = stateText;

        elem.appendChild(header);

        // Register View
        const registerContainer = document.createElement("div");
        registerContainer.style.cssText = "display: flex; flex-direction: column; margin-top: 10px;";
        const regTitle = document.createElement("span");
        regTitle.textContent = "Registers";
        regTitle.style.cssText = "font-size: 14px; font-weight: bold;";
        registerContainer.appendChild(regTitle);
        this.regView = document.createElement("div");
        this.regView.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
        registerContainer.appendChild(this.regView);
        elem.appendChild(registerContainer);

        // Flags View
        const flagsContainer = document.createElement("div");
        flagsContainer.style.cssText = "display: flex; flex-direction: column; margin-top: 10px;";
        const flagsTitle = document.createElement("span");
        flagsTitle.textContent = "Flags";
        flagsTitle.style.cssText = "font-size: 14px; font-weight: bold;";
        flagsContainer.appendChild(flagsTitle);
        this.flagsView = document.createElement("div");
        this.flagsView.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
        flagsContainer.appendChild(this.flagsView);
        elem.appendChild(flagsContainer);

        // Double View Block
        const dblViewBlock = document.createElement("div");
        dblViewBlock.style.cssText = "display: flex; flex-direction: row; gap: 5px; margin-top: 10px;";
        elem.appendChild(dblViewBlock);

        // Memory View
        const memoryContainer = document.createElement("div");
        memoryContainer.style.cssText = "display: flex; flex-direction: column; margin-top: 10px;";
        const memTitle = document.createElement("span");
        memTitle.textContent = "Memory";
        memTitle.style.cssText = "font-size: 14px; font-weight: bold;";
        memoryContainer.appendChild(memTitle);
        this.memView = document.createElement("div");
        this.memView.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 5px;
            overflow-y: auto;
            max-height: 400px;
            padding-right: 10px; /* Extra space for scrollbar so it doesnt overlap the last col */
        `;
        memoryContainer.appendChild(this.memView);
        dblViewBlock.appendChild(memoryContainer);

        this.memView.addEventListener("wheel", (e) => {
            e.preventDefault();

            const direction = Math.sign(e.deltaY);
            this.memView.scrollTop += direction * (/* Line Height */ 15 + /* Padding */ 5);
        }, { passive: false });

        // Logs View
        const logsContainer = document.createElement("div");
        logsContainer.style.cssText = "display: flex; flex-direction: column; margin-top: 10px; width: 100%;";
        const logsTitle = document.createElement("span");
        logsTitle.textContent = "Logs";
        logsTitle.style.cssText = "font-size: 14px; font-weight: bold;";
        logsContainer.appendChild(logsTitle);
        this.logsView = document.createElement("div");
        this.logsView.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 5px;
            overflow-y: auto;
            max-height: 400px;
            width: 100%;
            word-break: break-word;
            white-space: pre-wrap;
            max-width: 1024px;
        `;
        logsContainer.appendChild(this.logsView);
        dblViewBlock.appendChild(logsContainer);

        let oldLogger = window.EmCPU.log;
        window.EmCPU.log = (...args) => {
            this.loggerHook(...args);
            return oldLogger.apply(window.EmCPU, args);
        };

        this.logsView.addEventListener("wheel", (e) => {
            e.preventDefault();

            const direction = Math.sign(e.deltaY);
            this.logsView.scrollTop += direction * (/* Line Height */ 15 + /* Padding */ 5);
        }, { passive: false });

        // Control View
        const controls = document.createElement("div");
        controls.style.cssText = `
            display: flex;
            flex-direction: row;
            gap: 5px;
            margin-top: 10px;
        `;

        const leftArea = document.createElement("div");
        leftArea.style.cssText = "display: flex; flex-direction: row; gap: 5px; width: 100%; align-items: center; justify-content: flex-start;";
        controls.appendChild(leftArea);

        const ripText = document.createElement("span");
        ripText.textContent = "RIP: ";
        ripText.style.color = "#666";
        leftArea.appendChild(ripText);

        this.ripText = document.createElement("span");
        this.ripText.textContent = `0x${this.cpu.rip.toString(16).padStart(8, '0')}`;
        this.ripText.style.color = "white";
        leftArea.appendChild(this.ripText);

        const modeText = document.createElement("span");
        modeText.textContent = "Mode: ";
        modeText.style.color = "#666";
        leftArea.appendChild(modeText);

        this.modeText = document.createElement("span");
        this.modeText.textContent = this.cpu.mode;
        this.modeText.style.color = "white";
        leftArea.appendChild(this.modeText);

        const rightArea = document.createElement("div");
        rightArea.style.cssText = "display: flex; flex-direction: row; gap: 5px; width: 100%; align-items: center; justify-content: flex-end;";
        controls.appendChild(rightArea);

        const stepBtn = document.createElement("button");
        stepBtn.textContent = "Step";
        stepBtn.style.cssText = `
            background-color: #444;
            color: white;
            border: 1px solid #666;
            padding: 5px 10px;
            cursor: pointer;
        `;
        stepBtn.onclick = () => this.state = "stepping";
        rightArea.appendChild(stepBtn);

        const continueBtn = document.createElement("button");
        continueBtn.textContent = "Continue";
        continueBtn.style.cssText = `
            background-color: #444;
            color: white;
            border: 1px solid #666;
            padding: 5px 10px;
            cursor: pointer;
        `;
        continueBtn.onclick = () => this.state = "running";
        rightArea.appendChild(continueBtn);

        const stopBtn = document.createElement("button");
        stopBtn.textContent = "Stop";
        stopBtn.style.cssText = `
            background-color: #444;
            color: white;
            border: 1px solid #666;
            padding: 5px 10px;
            cursor: pointer;
        `;
        stopBtn.onclick = () => this.state = "stopped";
        rightArea.appendChild(stopBtn);

        elem.appendChild(controls);

        parent.appendChild(elem);
        this.elem = elem;

        this.renderRegisters();  // Initial
        this.renderMemory();     // Initial
        this.didInit = true;
    }

    renderRegisters() {
        if (!this.didInit) return;
        const regs = this.cpu.registers;
        const container = this.regView;
        const longest = Math.max(...Object.keys(regs).map(r => r.length));

        const columns = [];
        const CHUNK = 16;
        const entries = Object.entries(regs);
        for (let i = 0; i < entries.length; i += CHUNK) {
            const col = document.createElement("div");
            col.style.cssText = "display: flex; flex-direction: column; margin-right: 10px;";
            for (const [alias, real] of entries.slice(i, i + CHUNK)) {
                const prev = this.prevRegisters[alias];
                const curr = this.cpu[real];

                const row = document.createElement("div");
                row.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
                const label = document.createElement("span");
                label.textContent = `${alias}:`.padEnd(longest + 2, " ");
                label.style.color = "#666";
                label.style.whiteSpace = "pre";
                const value = document.createElement("span");
                value.textContent = `0x${curr.toString(16).padStart(16, '0')}`;

                if (prev !== curr) {
                    this.prevRegisters[alias] = curr;
                    value.style.transition = "background-color 0.5s ease-out";
                    value.style.backgroundColor = "rgb(33, 149, 243)";
                    setTimeout(() => {
                        value.style.backgroundColor = "transparent";
                    }, 500);
                }

                row.appendChild(label);
                row.appendChild(value);
                col.appendChild(row);
            }
            columns.push(col);
        }

        container.replaceChildren(...columns);
    }

    renderFlags() {
        if (!this.didInit) return;

        const flags = this.cpu.flags;
        const container = this.flagsView;
        const longest = Math.max(...Object.keys(flags).map(r => r.length));

        const items = [];
        const entries = Object.entries(flags);
        
        for (const [key, value] of entries) {
            const prev = this.prevFlags[key];
            const curr = value

            const section = document.createElement("div");
            section.style.cssText = "display: flex; flex-direction: row; gap: 5px; margin-right: 10px;";
            const label = document.createElement("span");
            label.textContent = `${key}:`.padEnd(longest + 2, " ");
            label.style.color = "#666";
            label.style.whiteSpace = "pre";
            const v = document.createElement("span");
            v.textContent = curr ? "1" : "0";
            v.style.color = "white";

            if (prev !== curr) {
                this.prevFlags[key] = curr;
                v.style.transition = "background-color 0.5s ease-out";
                v.style.backgroundColor = "rgb(33, 149, 243)";
                setTimeout(() => {
                    v.style.backgroundColor = "transparent";
                }, 500);
            }

            section.appendChild(label);
            section.appendChild(v);
            items.push(section);
        }

        container.replaceChildren(...items);
    }

    renderMemory(pageStart = 0, pageSize = 512) {
        const view = this.memView;
        const mem = new Uint8Array(this.cpu.memory.buffer);
        const chunkSize = 16;
        const end = Math.min(pageStart + pageSize, mem.length);

        const columns = [
            (() => {
                const row = document.createElement("div");
                row.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
                const addr = document.createElement("span");
                addr.textContent = " ".repeat(8);
                addr.style.whiteSpace = "pre";
                row.appendChild(addr);

                const data = Array.from({ length: chunkSize }, (_, i) => i.toString(16).padStart(2, '0'));

                data.forEach((byte, idx) => {
                    const prev = this.prevMemory[idx];
                    if (prev !== byte) {
                        this.prevMemory[idx] = byte;
                    }
                    const cell = document.createElement("span");
                    cell.textContent = byte;
                    cell.style.color = "#666";
                    cell.style.whiteSpace = "pre";
                    row.appendChild(cell);
                });
                return row;
            })()
        ];

        for (let i = pageStart; i < end; i += chunkSize) {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; flex-direction: row; gap: 5px;";
            const addr = document.createElement("span");
            addr.textContent = `${i.toString(16).padStart(8, '0')}`;
            addr.style.color = "#666";
            addr.style.whiteSpace = "pre";
            row.appendChild(addr);

            for (let j = 0; j < chunkSize; j++) {
                const b = mem[i + j];
                const prev = this.prevMemory[i + j];

                const cell = document.createElement("span");
                cell.textContent = b.toString(16).padStart(2, '0');
                cell.style.color = "#ccc";
                cell.style.whiteSpace = "pre";

                cell.addEventListener("click", () => {
                    if (this.brkPoints.has(BigInt(i + j))) {
                        this.brkPoints.delete(BigInt(i + j));
                        cell.style.outline = "none";
                    } else {
                        this.brkPoints.add(BigInt(i + j));
                        cell.style.outline = "2px solid #c00000";
                    }
                });

                // changed AND is RIP
                if (prev !== b && this.cpu.rip === BigInt(i + j)) {
                    this.prevMemory[i + j] = b;
                    cell.style.transition = "background-color 0.5s ease-out";
                    cell.style.backgroundColor = "rgba(33, 149, 243, 0.5)";
                    setTimeout(() => {
                        cell.style.backgroundColor = "rgb(192, 86, 0)";
                    }, 500);
                
                // did not changed BUT is RIP
                } else if (this.cpu.rip === BigInt(i + j)) {
                    cell.style.backgroundColor = "rgb(192, 86, 0)";
                
                // changed BUT is not RIP
                } else if (prev !== b) {
                    this.prevMemory[i + j] = b;
                    cell.style.transition = "background-color 0.5s ease-out";
                    cell.style.backgroundColor = "rgb(33, 149, 243)";
                    setTimeout(() => {
                        cell.style.backgroundColor = "transparent";
                    }, 500);
                }

                if (this.brkPoints.has(BigInt(i + j))) {
                    cell.style.outline = "2px solid #c00000";
                }

                row.appendChild(cell);
            }
            columns.push(row);
        }

        view.replaceChildren(...columns);
    }

    loggerHook(...args) {
        const elem = document.createElement("div");
        elem.style.cssText = `
            width: 100%;
            height: max-content;
        `;

        const time = document.createElement("span");

        const now = new Date();

        const options = {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZoneName: 'short'
        };

        const parts = new Intl.DateTimeFormat('en-IN', options).formatToParts(now);

        const get = type => parts.find(p => p.type === type)?.value;

        const day = get('day');
        const month = get('month');
        const year = get('year');
        const hour = get('hour');
        const minute = get('minute');
        const second = get('second');
        const dayPeriod = get('dayPeriod').toUpperCase();
        const tzName = get('timeZoneName');

        const ms = Math.floor(now.getMilliseconds() / 10).toString().padStart(2, '0');

        time.textContent = `${day}/${month}/${year} @ ${hour}:${minute}:${second}.${ms} ${dayPeriod} ${tzName}:`;
        time.style.color = "#666";
        time.style.whiteSpace = "pre";
        time.style.marginRight = "5px";
        elem.appendChild(time);

        args.forEach((arg, idx, arr) => {
            const span = document.createElement("span");
            span.textContent = arg;
            span.style.whiteSpace = "pre";
            span.style.marginRight = idx === arr.length - 1 ? "0" : "5px";
            elem.appendChild(span);
        });

        const wasAtBottom = this.logsView.scrollHeight - this.logsView.scrollTop <= this.logsView.clientHeight + 5;

        this.logsView.appendChild(elem);

        if (wasAtBottom) {
            this.logsView.scrollTop = this.logsView.scrollHeight;
        }
    }

    async tick() {
        if (!this.didInit) return;
        this.renderRegisters();
        this.renderFlags();
        this.renderMemory(0x7c00, 512);

        this.ripText.textContent = `0x${this.cpu.rip.toString(16).padStart(8, '0')}`;
        this.modeText.textContent = this.cpu.mode;

        // Stop at breakpoint
        if (this.brkPoints.has(this.cpu.rip)) {
            this.state = "stopped";
        }

        await this.waitForStep();
    }

    waitForStep() {
        return new Promise(resolve => {
            const poll = () => {
                if (this.state === "stepping") {
                    this.state = "stopped";
                    return resolve();
                }
                if (this.state === "running") {
                    return resolve();
                }
                requestAnimationFrame(poll);
            };
            poll();
        });
    }
}
