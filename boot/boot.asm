bits 64
org 0x7C00

CODE_SEG equ 0x08

GDT_BASE    equ 0x8000
IDT_BASE    equ GDT_BASE + 16

_start:
    ; --- STEP 1: Create the GDT ---
    mov rdi, GDT_BASE
    mov qword [rdi], 0
    mov rax, 0x00209A0000000000
    mov [rdi+8], rax

    ; --- STEP 2: Create the IDT Entry ---
    ; This is the new, foolproof method.
    mov rdi, IDT_BASE + 14 * 16  ; Pointer to IDT entry #14

    ; Load the handler address into a register.
    mov rax, page_fault_handler

    ; RDX will hold the low 8 bytes of the descriptor.
    ; RCX will hold the high 8 bytes.

    ; Construct the low qword in RDX
    mov rdx, rax
    mov rbx, 0x00000000FFFFFFFF
    and rdx, rbx ; Keep only the low 32 bits of the address for now
    mov rcx, rax
    shr rcx, 16
    mov rbx, 0x0000F000
    and rcx, rbx          ; This is a trick to get bits 31:16 into place
    or rdx, rcx
    mov rbx, 0x8E0000000000
    or rdx, rbx       ; Or in the Type/Attributes
    mov rcx, CODE_SEG
    shl rcx, 16
    or rdx, rcx                  ; Or in the Code Segment

    ; Construct the high qword in RCX
    mov rcx, rax
    shr rcx, 32

    ; Write the two qwords to memory. This is atomic and simple.
    mov [rdi], rdx
    mov [rdi+8], rcx

    ; --- STEP 3: Load Descriptors ---
    lgdt [gdt_descriptor]
    lidt [idt_descriptor]
    mov rsp, 0x90000

    ; --- STEP 4: Long Mode & Test ---
    mov rax, 0xC0000080
    mov rcx, rax
    mov rax, 0x101
    xor rdx, rdx
    wrmsr
    mov rax, 0x80000001
    mov cr0, rax
    mov rax, 0x20
    mov cr4, rax

    mov rbx, 0xDEADBEEF0000
    mov rax, [rbx]

    mov rcx, 0xDEADBEEF
    hlt

page_fault_handler:
    mov rcx, 0xCAFEBABE
    hlt

gdt_descriptor:
    dw 16 - 1
    dq GDT_BASE

idt_descriptor:
    dw (256 * 16) - 1
    dq IDT_BASE

times 510-($-$$) db 0
dw 0xAA55