; =============================================
;  Part 1: 16-bit Real Mode Entry Point
; =============================================
bits 16
org 0x7C00

_start:
    ; NOTE: We are in 16-bit Real Mode here.
    ; We cannot use 64-bit registers or addressing.
    
    ; The CPU starts in a state compatible with what we need.
    ; Our emulator's setup of CR0, EFER, etc., happens here.
    ; For a real machine, you'd set up a GDT first.
    
    ; The goal is to get into long mode as fast as possible.
    ; Your JS code already sets up paging, GDT, IDT.
    ; So, we just need to flip the bits in the registers.
    
    ; We need to use 32-bit instructions to write to CR0, etc.
    ; We can do this with operand-size prefixes.
    
    ; Enable Long Mode in EFER
    mov ecx, 0xC0000080 ; EFER MSR
    mov eax, 0x101     ; LME=1, NXE=1
    mov edx, 0
    wrmsr

    ; Enable Paging in CR0
    mov eax, cr0
    or eax, 0x80000001 ; PE=1, PG=1
    mov cr0, eax
    
    ; Enable PAE in CR4
    mov eax, cr4
    or eax, 0x20       ; PAE=1
    mov cr4, eax

    ; Now, perform a far jump to our 64-bit code.
    ; This jump will load CS with a 64-bit segment selector and
    ; tell the CPU to start interpreting instructions as 64-bit.
    ; 0x08 is the selector for our 64-bit code segment from the GDT.
    jmp 0x08:long_mode_start

; =============================================
;  Part 2: 64-bit Long Mode Code
; =============================================
bits 64
long_mode_start:
    ; We are now officially in 64-bit Long Mode!
    ; We can use 64-bit registers.
    
    ; Set up the stack
    mov rsp, 0x90000
    
    ; Run the test (e.g., the keyboard echo test)
    mov rsi, prompt_message
    call print

.main_loop:
    .wait_for_key:
        in al, 0x64
        test al, 1
        jz .wait_for_key
    in al, 0x60
    
    push rax
    mov rsi, echo_prefix
    call print
    pop rax
    
    mov rsi, temp_char
    mov [rsi], al
    call print
    jmp .main_loop

; --- Functions ---
print:
    push rax
    push rdx
    push rsi
    mov dx, 0x3F8
    .loop:
        lodsb
        cmp al, 0
        je .done
        out dx, al
        jmp .loop
    .done:
        pop rsi
        pop rdx
        pop rax
        ret

; --- Data ---
prompt_message:
    db "Keyboard is active. Type something!", 0x0A, 0
echo_prefix:
    db 0x0A, "You typed: ", 0
temp_char:
    db 0, 0

times 510-($-$$) db 0
dw 0xAA55