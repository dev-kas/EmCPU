[bits 64]
[org 0x7C00]

_start:
    ; Set up stack pointer
    mov rsp, 0x00007C00

    mov rax, 0xDEADBEEFDEADBEEF
    mov rbx, rax

    call function

    cmp rax, rbx
    jne .success

.failure:
    mov rbx, 0xBAD1BAD1BAD1BAD1
    mov rcx, 0xBAD2BAD2BAD2BAD2
    mov rdx, 0xBAD3BAD3BAD3BAD3
    hlt

.success:
    hlt

function:
    ;mov rax, 0x0123456789ABCDEF
    ret

; Boot sector padding and signature
times 510-($-$$) db 0
dw 0xAA55