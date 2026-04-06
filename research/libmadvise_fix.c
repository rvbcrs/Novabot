/*
 * libmadvise_fix.c — LD_PRELOAD shim voor Node.js 20 op kernel 4.14.87
 *
 * Node.js 20 V8 roept madvise() en mprotect() aan vanuit de GC en JIT.
 * Op kernel 4.14.87 (Horizon Robotics X3) falen deze syscalls met EPERM.
 * V8 crasht dan met "DiscardSystemPages" of "SetPermissionsOnExecutableMemoryChunk".
 *
 * Oplossing: intercepteer de aanroepen en negeer fouten (return 0).
 * Gebruik samen met NODE_OPTIONS=--jitless voor volledige stabiliteit.
 *
 * Compileren op ARM64:
 *   gcc -shared -fPIC -o libmadvise_fix.so libmadvise_fix.c -ldl
 *
 * Activeren:
 *   export LD_PRELOAD=/root/libmadvise_fix.so
 *   node --jitless dist/index.js
 */
#define _GNU_SOURCE
#include <sys/mman.h>
#include <dlfcn.h>
#include <errno.h>
#include <stddef.h>

typedef int (*real_madvise_t)(void *, size_t, int);
typedef int (*real_mprotect_t)(void *, size_t, int);

int madvise(void *addr, size_t length, int advice) {
    static real_madvise_t real_fn = NULL;
    if (!real_fn) real_fn = (real_madvise_t)dlsym(RTLD_NEXT, "madvise");
    int ret = real_fn(addr, length, advice);
    if (ret != 0) { errno = 0; return 0; }
    return ret;
}

int mprotect(void *addr, size_t len, int prot) {
    static real_mprotect_t real_fn = NULL;
    if (!real_fn) real_fn = (real_mprotect_t)dlsym(RTLD_NEXT, "mprotect");
    int ret = real_fn(addr, len, prot);
    if (ret != 0) { errno = 0; return 0; }
    return ret;
}
