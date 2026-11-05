// A single-producer single-consumer ring of float samples, from the microphone's realtime IO
// thread to its drain queue (docs/notes/dictation-auhal.md). Plain C with no audio in it, so it
// can be compiled and run on its own.
//
// Neither side locks or allocates. head and tail count samples ever written and read, so
// head - tail is what is waiting; only the low bits index buf. Each side stores only its own
// counter, with release, and reads the other's with acquire: that is what makes the samples
// themselves visible, and what stops the producer reusing a slot the consumer is still reading.

#ifndef CF_MIC_RING_DARWIN_H
#define CF_MIC_RING_DARWIN_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2, "the IO thread must not take a lock");

typedef struct {
	float* buf;
	uint64_t mask; // capacity - 1
	_Atomic uint64_t head;
	_Atomic uint64_t tail;
	_Atomic uint64_t dropped; // samples refused because the ring was full
} cfMicRing;

// cfMicRingInit makes r hold capacity samples, a power of two. The memory is written here so
// the IO thread never takes the page fault for it. 0, or -1 if there is no memory.
static inline int cfMicRingInit(cfMicRing* r, size_t capacity) {
	r->buf = malloc(capacity * sizeof(float));
	if (r->buf == NULL) return -1;
	memset(r->buf, 0, capacity * sizeof(float));
	r->mask = capacity - 1;
	atomic_init(&r->head, 0);
	atomic_init(&r->tail, 0);
	atomic_init(&r->dropped, 0);
	return 0;
}

// cfMicRingFree is safe on a ring that was never initialized, if it was zeroed.
static inline void cfMicRingFree(cfMicRing* r) {
	free(r->buf);
	r->buf = NULL;
}

// cfMicRingWrite is the producer's side: all n samples go in, or none do and they are counted
// as dropped. It reports which, 1 or 0.
static inline int cfMicRingWrite(cfMicRing* r, const float* src, size_t n) {
	uint64_t head = atomic_load_explicit(&r->head, memory_order_relaxed);
	uint64_t tail = atomic_load_explicit(&r->tail, memory_order_acquire);
	size_t capacity = (size_t)r->mask + 1;
	if (n > capacity - (size_t)(head - tail)) {
		atomic_fetch_add_explicit(&r->dropped, n, memory_order_relaxed);
		return 0;
	}
	size_t at = (size_t)(head & r->mask);
	size_t first = capacity - at < n ? capacity - at : n;
	memcpy(r->buf + at, src, first * sizeof(float));
	memcpy(r->buf, src + first, (n - first) * sizeof(float));
	atomic_store_explicit(&r->head, head + n, memory_order_release);
	return 1;
}

// cfMicRingRead is the consumer's side: up to most samples into dst, returning how many.
static inline size_t cfMicRingRead(cfMicRing* r, float* dst, size_t most) {
	uint64_t tail = atomic_load_explicit(&r->tail, memory_order_relaxed);
	uint64_t head = atomic_load_explicit(&r->head, memory_order_acquire);
	size_t capacity = (size_t)r->mask + 1;
	size_t n = (size_t)(head - tail);
	if (n > most) n = most;
	size_t at = (size_t)(tail & r->mask);
	size_t first = capacity - at < n ? capacity - at : n;
	memcpy(dst, r->buf + at, first * sizeof(float));
	memcpy(dst + first, r->buf, (n - first) * sizeof(float));
	atomic_store_explicit(&r->tail, tail + n, memory_order_release);
	return n;
}

#endif
