# hv-toy

Tiny `Hypervisor.framework` experiment.

This is deliberately not a Linux VM. It is the smallest useful VMM-shaped
program:

1. create a VM;
2. allocate guest physical memory;
3. copy a few ARM64 instructions into that memory;
4. create one vCPU;
5. point the vCPU program counter at the guest code;
6. run until the guest writes to fake MMIO;
7. emulate a tiny UART device;
8. advance the guest program counter and resume the vCPU.

That is the layer below `Virtualization.framework`: no disks, no virtio devices,
no guest kernel, no initramfs. Just memory, registers, execution, and exits.

## Run

```sh
make -C experiments/hv-toy run
```

Expected shape:

```text
host: creating VM
host: mapped 16384 bytes at guest IPA 0x100000
host: running guest; fake UART output follows:
guest: hello from guest

host: guest wrote NUL to fake UART; stopping run loop
```

If `hv_vm_create` returns `HV_DENIED`, the host process is not allowed to use the
hypervisor on this machine/session.

## What the guest does

The guest payload is a short sequence of AArch64 instructions:

```asm
mov x1, #0x200000
mov x0, #'h'
str x0, [x1]
mov x0, #'e'
str x0, [x1]
...
mov x0, #0
str x0, [x1]
b .
```

Only `0x100000..0x103fff` is mapped as guest RAM. The store to `0x200000`
therefore traps back to the host as a stage-2 fault. That is the first tiny
piece of a device model: a real VMM would catch this, recognize that `0x200000`
belongs to a fake UART/virtio device, and emulate the write.

This experiment resumes the guest after each fake UART write:

```text
guest: str x0, [x1]
       VM exit to host
host:  print low byte of x0
host:  PC += 4
host:  hv_vcpu_run(...)
```
