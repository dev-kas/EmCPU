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

        this._memViewOffset = 0x7c00;
        this.memViewSize = 512;

        this._state = "stopped";

        this.prevRegisters = {};
        this.prevFlags = {};
        this.prevMemory = new Uint8Array(cpu.memory.buffer.byteLength);

        this.brkPoints = new Set();
    }

    get memViewOffset() { return this._memViewOffset }
    set memViewOffset(value) { this._memViewOffset = Math.max(0, Math.min(value, this.cpu.memory.buffer.byteLength - this.memViewSize)) }

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
        const memTitleBar = document.createElement("div");
        memTitleBar.style.cssText = "display: flex; flex-direction: row; gap: 5px; align-items: center;";
        const memTitle = document.createElement("span");
        memTitle.textContent = "Memory";
        memTitle.style.cssText = "font-size: 14px; font-weight: bold;";
        memTitleBar.appendChild(memTitle);
        const memOffsetDec = document.createElement("button");
        memOffsetDec.textContent = "<";
        memOffsetDec.style.cssText = "background-color: #444; color: white; border: 1px solid #666; padding: 2px 5px; cursor: pointer;";
        memOffsetDec.onclick = () => {
            this.memViewOffset -= this.memViewSize;
            this.renderMemory(this.memViewOffset, this.memViewSize);
            memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
        };
        memTitleBar.appendChild(memOffsetDec);
        const memOffsetInput = document.createElement("input");
        memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
        memOffsetInput.style.cssText = "background-color: #444; color: white; border: 1px solid #666; padding: 2px 5px; cursor: text;";
        memOffsetInput.oninput = () => {
            this.memViewOffset = parseInt(memOffsetInput.value, 16);
            this.renderMemory(this.memViewOffset, this.memViewSize);
        };
        memOffsetInput.onchange = () => {
            let expr = memOffsetInput.value.trim();
            let offset = 0;

            try {
                expr = expr.replace(/\b[0-9a-fA-F]+\b/g, match => parseInt(match, 16));
                offset = Function(`"use strict"; return ([${expr}])`)()[0];
                memOffsetInput.value = offset.toString(16).toUpperCase();
            } catch (e) {
                offset = parseInt(memOffsetInput.value, 16);
            }

            this.memViewOffset = offset;
            this.renderMemory(this.memViewOffset, this.memViewSize);
            memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
        }
        memOffsetInput.onkeydown = (e) => {
            switch (e.key) {
                case "ArrowUp":
                    this.memViewOffset += Math.max(1, e.shiftKey * 16);
                    this.renderMemory(this.memViewOffset, this.memViewSize);
                    memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
                    break;
                case "ArrowDown":
                    this.memViewOffset -= Math.max(1, e.shiftKey * 16);
                    this.renderMemory(this.memViewOffset, this.memViewSize);
                    memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
                    break;
            }
        }
        memTitleBar.appendChild(memOffsetInput);
        const memOffsetInc = document.createElement("button");
        memOffsetInc.textContent = ">";
        memOffsetInc.style.cssText = "background-color: #444; color: white; border: 1px solid #666; padding: 2px 5px; cursor: pointer;";
        memOffsetInc.onclick = () => {
            this.memViewOffset += this.memViewSize;
            this.renderMemory(this.memViewOffset, this.memViewSize);
            memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
        };
        memTitleBar.appendChild(memOffsetInc);
        const memOffsetJTR = document.createElement("button");
        memOffsetJTR.textContent = String.fromCodePoint(0x2609);
        memOffsetJTR.style.cssText = "background-color: #444; color: white; border: 1px solid #666; padding: 2px 5px; cursor: pointer;";
        memOffsetJTR.onclick = () => {
            this.memViewOffset = Number(this.cpu.rip ?? 0);
            this.renderMemory(this.memViewOffset, this.memViewSize);
            memOffsetInput.value = this.memViewOffset.toString(16).toUpperCase();
        };
        memTitleBar.appendChild(memOffsetJTR);
        memoryContainer.appendChild(memTitleBar);
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
        const controlsView = document.createElement("div");
        controlsView.style.cssText = "display: flex; flex-direction: column; margin-top: 10px;";

        const ctrlsViewREPLContainer = document.createElement("div");
        ctrlsViewREPLContainer.style.cssText = "display: flex; flex-direction: row; gap: 5px; margin-top: 10px;";
        const ctrlsViewREPLInput = document.createElement("input");
        ctrlsViewREPLInput.style.cssText = "background-color: #444; color: white; border: 1px solid #666; padding: 5px 10px; cursor: text; width: 100%;";
        ctrlsViewREPLInput.placeholder = "Enter a command...";
        const ctrlsViewREPLInputHistory = [];
        let ctrlsViewREPLInputHistoryIndex = 0;
        ctrlsViewREPLInput.addEventListener("keydown", (e) => {
            switch (e.key) {
                case "Enter":
                    ctrlsViewREPLInputHistory.push(ctrlsViewREPLInput.value);
                    this.runREPLCommand(ctrlsViewREPLInput.value);
                    ctrlsViewREPLInput.value = "";
                    ctrlsViewREPLInputHistoryIndex = ctrlsViewREPLInputHistory.length;
                    break;
                case "ArrowUp":
                    if (ctrlsViewREPLInputHistoryIndex > 0) {
                        ctrlsViewREPLInput.value = ctrlsViewREPLInputHistory[--ctrlsViewREPLInputHistoryIndex] || "";
                    }
                    break;
                case "ArrowDown":
                    if (ctrlsViewREPLInputHistoryIndex < ctrlsViewREPLInputHistory.length) {
                        ctrlsViewREPLInput.value = ctrlsViewREPLInputHistory[++ctrlsViewREPLInputHistoryIndex] || "";
                    }
                    break;
            }
        });
        ctrlsViewREPLContainer.appendChild(ctrlsViewREPLInput);
        const ctrlsViewREPLBtn = document.createElement("button");
        ctrlsViewREPLBtn.textContent = String.fromCodePoint(0x25B6);
        ctrlsViewREPLBtn.style.cssText = `
            background-color: #444;
            color: white;
            border: 1px solid #666;
            padding: 5px 10px;
            cursor: pointer;
        `;
        ctrlsViewREPLBtn.onclick = () => {
            ctrlsViewREPLInputHistory.push(ctrlsViewREPLInput.value);
            this.runREPLCommand(ctrlsViewREPLInput.value)
            ctrlsViewREPLInput.value = "";
            ctrlsViewREPLInputHistoryIndex = ctrlsViewREPLInputHistory.length;
        };
        ctrlsViewREPLContainer.appendChild(ctrlsViewREPLBtn);
        controlsView.appendChild(ctrlsViewREPLContainer);

        const ctrlsViewMainRow = document.createElement("div");
        ctrlsViewMainRow.style.cssText = `
            display: flex;
            flex-direction: row;
            gap: 5px;
            margin-top: 10px;
        `;

        const leftArea = document.createElement("div");
        leftArea.style.cssText = "display: flex; flex-direction: row; gap: 5px; width: 100%; align-items: center; justify-content: flex-start;";
        ctrlsViewMainRow.appendChild(leftArea);

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
        ctrlsViewMainRow.appendChild(rightArea);

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

        controlsView.appendChild(ctrlsViewMainRow);
        elem.appendChild(controlsView);

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

    runREPLCommand(command) {
        const proxy = new Proxy({}, {
            has: () => true,
            get: (_, key) => (key in this.cpu ? this.cpu[key] : undefined),
            set: (_, key, val) => {
            if (key in this.cpu) this.cpu[key] = val;
            return true;
            }
        });
        
        try {
            const scopedFn = new Function("with(this) { return [" + command + "]; }");
            const result = scopedFn.call(proxy)[0];
            switch (typeof result) {
                case "undefined":
                    this.loggerHook("undefined");
                    break;
                case "object":
                    if (result === null) {
                        this.loggerHook("null");
                    } else {
                        this.loggerHook(JSON.stringify(result));
                    }
                    break;
                case "string":
                    this.loggerHook(result);
                    break;
                case "number":
                    this.loggerHook(`${result} (0x${result.toString(16)})`);
                    break;
                case "bigint":
                    this.loggerHook(`${result}n (0x${result.toString(16)}n)`);
                    break;
                case "boolean":
                    this.loggerHook(result ? "true" : "false");
                    break;
                default:
                    this.loggerHook(result);
                    break;
            }
        } catch (e) {
            this.loggerHook("REPL error:", e.message);
        }
    }

    async tick() {
        if (!this.didInit) return;
        this.renderRegisters();
        this.renderFlags();
        this.renderMemory(this.memViewOffset, this.memViewSize);

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
