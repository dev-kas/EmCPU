bits 64 ; Ensure NASM generates 64-bit code

; We expect to be loaded at 0x7C00
org 0x7C00

_start:
    ; --- Minimal Long Mode Setup ---
    ; These instructions are essential and already handled by the emulator.
    ; They establish the 64-bit execution environment with paging.

    ; Setup EFER MSR (0xC0000080) for Long Mode Enable (LME=1)
    mov rax, 0xC0000080  ; EFER MSR address
    mov rcx, rax         ; RCX holds MSR address for WRMSR
    mov rax, 0x101       ; EFER value (LME=1, SCE=1 for syscall/sysret if needed later)
    xor rdx, rdx         ; Upper 32 bits of RDX for WRMSR (set to 0)
    wrmsr                ; EFER is now set, LME is enabled. CPU is still in protected mode for now.

    ; Enable paging (set CR0.PG=1, PE=1)
    ; PE bit (CR0.0) needs to be set to enter protected mode
    ; PG bit (CR0.31) needs to be set to enable paging
    mov rax, 0x80000001  ; CR0.PG=1, CR0.PE=1
    mov cr0, rax         ; Protected mode and paging enabled

    ; Set PAE bit in CR4
    ; PAE bit (CR4.5) enables Physical Address Extension for 4-level paging.
    mov rax, 0x20        ; CR4.PAE=1
    mov cr4, rax         ; Long mode is now active (assuming LME, PAE, PG are all set)

    ; --- End Long Mode Setup ---

    ; --- Conditional Jump Tests ---

    ; Test 1: ZF = 1 Scenario (A == B)
    mov r8, 0x1111111122222222 ; Marker for this test block
    mov rax, 0x5
    mov rbx, 0x5
    cmp rax, rbx ; RAX - RBX = 0, so ZF = 1

    ; Test 1.1: JE/JZ - Should JUMP (ZF is 1)
    mov r10, 0xDEADBEEFDEADBEEF ; Value if not jumped
    je  .je_target_success      ; This jump should be taken
    mov r10, 0x1111111111111111 ; This line should be SKIPPED
.je_target_success:
    mov r10, 0xAAAAAAAABBBBBBBB ; R10 should be this value (success)

    ; Test 1.2: JNE/JNZ - Should NOT JUMP (ZF is 1)
    mov r11, 0xCAFECAFECAFECAFE ; Value if not jumped
    jne .jne_target_skipped     ; This jump should NOT be taken (ZF is 1)
    mov r11, 0xBBBBBBBBCCCCCCCC ; This line should be EXECUTED
.jne_target_skipped: ; This label is just to provide a target, should be reached sequentially
    mov r11, 0xDDDDDDDDDDDDDDDD ; R11 should be 0xBBBB... (from previous line) because jump was skipped


    ; Test 2: ZF = 0 Scenario (A != B)
    mov r12, 0x3333333344444444 ; Marker for this test block
    mov rax, 0x10
    mov rbx, 0x5
    cmp rax, rbx ; RAX - RBX = 5, so ZF = 0

    ; Test 2.1: JE/JZ - Should NOT JUMP (ZF is 0)
    mov r13, 0xDEADBEEFDEADBEEF ; Value if not jumped
    je .je_target_skipped_2     ; This jump should NOT be taken (ZF is 0)
    mov r13, 0xEEEEEEEEFFFFFFFF ; This line should be EXECUTED
.je_target_skipped_2: ; This label is just to provide a target, should be reached sequentially
    mov r13, 0x0000000012345678 ; R13 should be 0xEEEE... (from previous line) because jump was skipped

    ; Test 2.2: JNE/JNZ - Should JUMP (ZF is 0)
    mov r14, 0xCAFECAFECAFECAFE ; Value if not jumped
    jne .jne_target_success_2   ; This jump should be taken
    mov r14, 0x9999999999999999 ; This line should be SKIPPED
.jne_target_success_2:
    mov r14, 0x0000000000000000 ; R14 should be this value (success)


    ; Final NOP and HLT
    nop ; To ensure final RIP translation and instruction fetch
    hlt ; End emulation

; Boot sector padding and signature
times 510-($-$$) db 0
dw 0xAA55