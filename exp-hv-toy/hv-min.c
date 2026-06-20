#include <Hypervisor/Hypervisor.h>
#include <errno.h>
#include <mach/error.h>
#include <mach/mach_error.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

// Keep the experiment small enough to reason about directly.
// IPA means "Intermediate Physical Address": the guest's physical address.
static const uint64_t guest_code_ipa = 0x100000;
static const uint64_t fake_mmio_ipa = 0x200000;
static const size_t guest_ram_size = 16 * 1024;
static const size_t max_vm_exits = 128;

#define ARM64_MOV_X0_IMM16(value) (0xd2800000u | ((uint32_t)(value) << 5))
#define ARM64_MOV_X1_0X200000 0xd2a00401u
#define ARM64_STR_X0_TO_X1 0xf9000020u
#define ARM64_BRANCH_TO_SELF 0x14000000u

static const char *hv_error_name(hv_return_t ret) {
    switch (ret) {
    case HV_SUCCESS:
        return "HV_SUCCESS";
    case HV_ERROR:
        return "HV_ERROR";
    case HV_BUSY:
        return "HV_BUSY";
    case HV_BAD_ARGUMENT:
        return "HV_BAD_ARGUMENT";
    case HV_ILLEGAL_GUEST_STATE:
        return "HV_ILLEGAL_GUEST_STATE";
    case HV_NO_RESOURCES:
        return "HV_NO_RESOURCES";
    case HV_NO_DEVICE:
        return "HV_NO_DEVICE";
    case HV_DENIED:
        return "HV_DENIED";
    case HV_UNSUPPORTED:
        return "HV_UNSUPPORTED";
    default:
        return "unknown Hypervisor.framework error";
    }
}

static void require_hv(hv_return_t ret, const char *what) {
    if (ret == HV_SUCCESS) {
        return;
    }

    fprintf(stderr, "%s failed: %s (0x%x)\n", what, hv_error_name(ret), ret);
    const char *mach_message = mach_error_string(ret);
    if (mach_message != NULL) {
        fprintf(stderr, "mach: %s\n", mach_message);
    }
    exit(1);
}

static const char *exit_reason_name(hv_exit_reason_t reason) {
    switch (reason) {
    case HV_EXIT_REASON_CANCELED:
        return "canceled";
    case HV_EXIT_REASON_EXCEPTION:
        return "exception";
    case HV_EXIT_REASON_VTIMER_ACTIVATED:
        return "vtimer activated";
    case HV_EXIT_REASON_UNKNOWN:
        return "unknown";
    default:
        return "unrecognized";
    }
}

static uint32_t esr_exception_class(uint64_t syndrome) {
    // ESR_ELx bits [31:26] are the Exception Class. Apple exposes the raw ESR
    // value in hv_vcpu_exit_t.exception.syndrome.
    return (uint32_t)((syndrome >> 26) & 0x3f);
}

static void dump_exit(const hv_vcpu_exit_t *exit) {
    printf("host: exit reason = %s (%u)\n", exit_reason_name(exit->reason), exit->reason);

    if (exit->reason == HV_EXIT_REASON_EXCEPTION) {
        printf("host: syndrome = 0x%016llx, EC = 0x%02x\n",
               (unsigned long long)exit->exception.syndrome,
               esr_exception_class(exit->exception.syndrome));
        printf("host: fault VA = 0x%016llx, fault IPA = 0x%016llx\n",
               (unsigned long long)exit->exception.virtual_address,
               (unsigned long long)exit->exception.physical_address);
    }
}

int main(void) {
    printf("host: creating VM\n");
    require_hv(hv_vm_create(NULL), "hv_vm_create");

    // Hypervisor.framework maps ordinary host virtual memory into the guest
    // physical address space. The host still owns the allocation; the guest
    // just receives a physical mapping to it.
    void *guest_ram = mmap(NULL,
                           guest_ram_size,
                           PROT_READ | PROT_WRITE,
                           MAP_ANON | MAP_PRIVATE,
                           -1,
                           0);
    if (guest_ram == MAP_FAILED) {
        fprintf(stderr, "mmap failed: %s\n", strerror(errno));
        return 1;
    }
    memset(guest_ram, 0, guest_ram_size);

    // A tiny guest program, encoded as little-endian AArch64 instruction words:
    //
    //   mov x1, #0x200000
    //   mov x0, #'h'
    //   str x0, [x1]
    //   mov x0, #'i'
    //   str x0, [x1]
    //   ...
    //   b .
    //
    // Only 0x100000..0x103fff is mapped as guest RAM. The store to 0x200000
    // therefore creates a stage-2 fault. Real VMMs use this shape constantly:
    // leave a device's MMIO page unmapped, catch the fault, decode the access,
    // and emulate the device in host userspace.
    const uint32_t guest_code[] = {
        ARM64_MOV_X1_0X200000,
        ARM64_MOV_X0_IMM16('h'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('e'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('l'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('l'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('o'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16(' '),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('f'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('r'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('o'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('m'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16(' '),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('g'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('u'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('e'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('s'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('t'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16('\n'),
        ARM64_STR_X0_TO_X1,
        ARM64_MOV_X0_IMM16(0),
        ARM64_STR_X0_TO_X1,
        ARM64_BRANCH_TO_SELF,
    };
    memcpy(guest_ram, guest_code, sizeof(guest_code));

    require_hv(hv_vm_map(guest_ram,
                         guest_code_ipa,
                         guest_ram_size,
                         HV_MEMORY_READ | HV_MEMORY_WRITE | HV_MEMORY_EXEC),
               "hv_vm_map");
    printf("host: mapped %zu bytes at guest IPA 0x%llx\n",
           guest_ram_size,
           (unsigned long long)guest_code_ipa);

    hv_vcpu_t vcpu = 0;
    hv_vcpu_exit_t *exit = NULL;
    require_hv(hv_vcpu_create(&vcpu, &exit, NULL), "hv_vcpu_create");

    // Put the guest CPU at the first instruction. At this level there is no
    // firmware or bootloader; the VMM directly seeds architectural state.
    require_hv(hv_vcpu_set_reg(vcpu, HV_REG_PC, guest_code_ipa), "hv_vcpu_set_reg(PC)");

    printf("host: running guest; fake UART output follows:\n");
    printf("guest: ");
    fflush(stdout);

    for (size_t exit_count = 0; exit_count < max_vm_exits; exit_count++) {
        hv_return_t run_ret = hv_vcpu_run(vcpu);
        require_hv(run_ret, "hv_vcpu_run");

        uint64_t x0 = 0;
        uint64_t pc = 0;
        require_hv(hv_vcpu_get_reg(vcpu, HV_REG_X0, &x0), "hv_vcpu_get_reg(X0)");
        require_hv(hv_vcpu_get_reg(vcpu, HV_REG_PC, &pc), "hv_vcpu_get_reg(PC)");

        if (exit->reason == HV_EXIT_REASON_EXCEPTION &&
            exit->exception.physical_address == fake_mmio_ipa) {
            // Our fake UART convention is intentionally tiny: whatever low byte
            // the guest has in x0 is the byte being written to the serial port.
            // A real VMM would decode the faulting instruction to discover this.
            unsigned char byte = (unsigned char)(x0 & 0xff);
            if (byte == 0) {
                printf("\nhost: guest wrote NUL to fake UART; stopping run loop\n");
                break;
            }

            putchar(byte);
            fflush(stdout);

            // The trapped instruction was `str x0, [x1]`. Since we emulated it,
            // advance PC to the next instruction before resuming the guest.
            require_hv(hv_vcpu_set_reg(vcpu, HV_REG_PC, pc + 4), "hv_vcpu_set_reg(PC resume)");
            continue;
        }

        printf("\nhost: unexpected VM exit after %zu handled exits\n", exit_count);
        dump_exit(exit);
        printf("host: guest x0 = %llu\n", (unsigned long long)x0);
        printf("host: guest pc = 0x%llx\n", (unsigned long long)pc);
        break;
    }

    require_hv(hv_vcpu_destroy(vcpu), "hv_vcpu_destroy");
    require_hv(hv_vm_unmap(guest_code_ipa, guest_ram_size), "hv_vm_unmap");
    require_hv(hv_vm_destroy(), "hv_vm_destroy");

    if (munmap(guest_ram, guest_ram_size) != 0) {
        fprintf(stderr, "munmap failed: %s\n", strerror(errno));
        return 1;
    }

    return 0;
}
