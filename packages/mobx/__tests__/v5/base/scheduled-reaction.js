/**
 * @type {typeof import("./../../../src/v5/mobx")}
 */
const mobx = require("../../../src/mobx.ts")
const { ScheduledReaction, Reaction } = mobx
const $mobx = mobx.$mobx

/**
 * Creates a scheduler that batches reactions and runs them in the next task
 * using setTimeout(0).
 */
function createNextTaskScheduler() {
    const pending = []
    let isFlushScheduled = false

    function scheduler(reaction) {
        pending.push(reaction)

        if (!isFlushScheduled) {
            isFlushScheduled = true
            setTimeout(() => {
                isFlushScheduled = false
                // Drain the queue
                const toRun = pending.splice(0)
                for (const r of toRun) {
                    r.runReaction_()
                }
            }, 0)
        }
    }

    // Expose pending array for testing
    scheduler.pending = pending

    return scheduler
}

describe("ScheduledReaction", () => {
    test("basic: reaction defers execution to next task", async () => {
        const scheduler = createNextTaskScheduler()
        const runs = []
        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "test",
            function () {
                this.track(() => {
                    runs.push(state.value)
                })
            },
            scheduler
        )

        // Start the reaction
        reaction.schedule_()

        // Synchronously change state multiple times
        state.value = 1
        state.value = 2
        state.value = 3

        // Nothing should have run yet (still in same task)
        expect(runs).toEqual([])
        expect(scheduler.pending.length).toBeGreaterThan(0)

        // Wait for next task
        await new Promise(r => setTimeout(r, 0))

        // Should have run and tracked the final value
        expect(runs).toEqual([3])
    })

    test("multiple state changes batch into single reaction run", async () => {
        const scheduler = createNextTaskScheduler()
        let runCount = 0
        const state = mobx.observable({ a: 0, b: 0 })

        const reaction = new ScheduledReaction(
            "batcher",
            function () {
                this.track(() => {
                    runCount++
                    // Read both observables
                    void state.a
                    void state.b
                })
            },
            scheduler
        )

        reaction.schedule_()

        // Multiple changes to different observables
        state.a = 1
        state.b = 1
        state.a = 2
        state.b = 2
        state.a = 3

        expect(runCount).toBe(0)

        await new Promise(r => setTimeout(r, 0))

        // Should have run exactly once with all changes batched
        expect(runCount).toBe(1)
    })

    test("disposed reaction does not run even if scheduled", async () => {
        const scheduler = createNextTaskScheduler()
        const runs = []
        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "disposable",
            function () {
                this.track(() => {
                    runs.push(state.value)
                })
            },
            scheduler
        )

        reaction.schedule_()
        state.value = 1

        // Dispose before the scheduled run
        reaction.dispose()

        await new Promise(r => setTimeout(r, 0))

        // Should not have run
        expect(runs).toEqual([])
        expect(reaction.isDisposed).toBe(true)
    })

    test("reaction becoming stale while already scheduled does not double-queue", async () => {
        let schedulerCalls = 0
        const pending = []
        let isFlushScheduled = false

        function countingScheduler(reaction) {
            schedulerCalls++
            pending.push(reaction)

            if (!isFlushScheduled) {
                isFlushScheduled = true
                setTimeout(() => {
                    isFlushScheduled = false
                    const toRun = pending.splice(0)
                    for (const r of toRun) {
                        r.runReaction_()
                    }
                }, 0)
            }
        }

        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "no-double-queue",
            function () {
                this.track(() => {
                    void state.value
                })
            },
            countingScheduler
        )

        reaction.schedule_()
        expect(schedulerCalls).toBe(1)

        // Multiple state changes while already scheduled
        state.value = 1
        state.value = 2
        state.value = 3

        // Scheduler should only have been called once (initial schedule)
        // because isScheduled flag prevents re-queueing
        expect(schedulerCalls).toBe(1)

        await new Promise(r => setTimeout(r, 0))
    })

    test("mixed reactions: ScheduledReaction and regular Reaction interact correctly", async () => {
        const scheduler = createNextTaskScheduler()
        const scheduledRuns = []
        const regularRuns = []
        const state = mobx.observable({ value: 0 })

        // Regular reaction - runs synchronously
        const regularReaction = mobx.autorun(() => {
            regularRuns.push(state.value)
        })

        // Scheduled reaction - runs in next task
        const scheduledReaction = new ScheduledReaction(
            "scheduled",
            function () {
                this.track(() => {
                    scheduledRuns.push(state.value)
                })
            },
            scheduler
        )
        scheduledReaction.schedule_()

        // Nothing recorded yet
        expect(scheduledRuns).toEqual([])
        // Regular autorun runs immediately on creation
        expect(regularRuns).toEqual([0])

        // Change state
        state.value = 1

        // Regular reaction runs synchronously
        expect(regularRuns).toEqual([0, 1])
        // Scheduled reaction still waiting
        expect(scheduledRuns).toEqual([])

        await new Promise(r => setTimeout(r, 0))

        // Now scheduled reaction has run
        expect(scheduledRuns).toEqual([1])

        regularReaction()
        scheduledReaction.dispose()
    })

    test("error handling works correctly", async () => {
        const scheduler = createNextTaskScheduler()
        const errors = []
        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "error-test",
            function () {
                this.track(() => {
                    if (state.value === 1) {
                        throw new Error("Test error")
                    }
                })
            },
            scheduler,
            error => {
                errors.push(error.message)
            }
        )

        reaction.schedule_()
        state.value = 1

        await new Promise(r => setTimeout(r, 0))

        expect(errors).toEqual(["Test error"])
        reaction.dispose()
    })

    test("cascading to regular reactions: ScheduledReaction modifying state triggers sync reactions", async () => {
        const scheduler = createNextTaskScheduler()
        const regularRuns = []
        const state = mobx.observable({ a: 0, b: 0 })

        // Regular reaction observing 'b'
        const regularReaction = mobx.autorun(() => {
            regularRuns.push(state.b)
        })

        // Scheduled reaction that modifies 'b' when 'a' changes
        const scheduledReaction = new ScheduledReaction(
            "cascading",
            function () {
                this.track(() => {
                    // When a changes, update b
                    mobx.runInAction(() => {
                        state.b = state.a * 10
                    })
                })
            },
            scheduler
        )
        scheduledReaction.schedule_()

        // Initial state
        expect(regularRuns).toEqual([0])

        // Change 'a' - scheduled reaction is queued but hasn't run
        state.a = 1
        expect(regularRuns).toEqual([0]) // 'b' hasn't changed yet

        // Wait for scheduled reaction
        await new Promise(r => setTimeout(r, 0))

        // Scheduled reaction ran and modified 'b', triggering regular reaction synchronously
        expect(regularRuns).toEqual([0, 10])

        regularReaction()
        scheduledReaction.dispose()
    })

    test("getDisposer_ returns working disposer", async () => {
        const scheduler = createNextTaskScheduler()
        const runs = []
        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "disposer-test",
            function () {
                this.track(() => {
                    runs.push(state.value)
                })
            },
            scheduler
        )

        const disposer = reaction.getDisposer_()
        reaction.schedule_()

        state.value = 1
        disposer()

        await new Promise(r => setTimeout(r, 0))

        expect(runs).toEqual([])
        expect(reaction.isDisposed).toBe(true)
        expect(disposer[$mobx]).toBe(reaction)
    })

    test("Symbol.dispose support", async () => {
        Symbol.dispose ??= Symbol("Symbol.dispose")

        const scheduler = createNextTaskScheduler()
        const state = mobx.observable({ value: 0 })

        const reaction = new ScheduledReaction(
            "symbol-dispose",
            function () {
                this.track(() => {
                    void state.value
                })
            },
            scheduler
        )

        const disposer = reaction.getDisposer_()

        expect(disposer[Symbol.dispose]).toBeInstanceOf(Function)

        disposer[Symbol.dispose]()
        expect(reaction.isDisposed).toBe(true)
    })
})

describe("Computed value recalculation timing", () => {
    /**
     * This test verifies a key difference between ScheduledReaction and regular Reaction:
     *
     * When a reaction observes a computed value and the computed's dependency changes:
     * - Regular Reaction: shouldCompute() is called synchronously, which calls computed.get()
     *   to determine if the computed actually changed. This triggers computed recalculation.
     * - ScheduledReaction: runReaction_() (and thus shouldCompute()) is deferred until
     *   the scheduler fires. Computed recalculation is also deferred.
     */

    test("Regular Reaction: computed is recalculated synchronously when dependency changes", () => {
        let computedCallCount = 0
        const state = mobx.observable({ value: 0 })

        const derived = mobx.computed(() => {
            computedCallCount++
            return state.value * 2
        })

        const runs = []
        const reaction = new mobx.Reaction("RegularReaction", function () {
            this.track(() => {
                runs.push(derived.get())
            })
        })
        reaction.schedule_()

        // Initial run: computed is calculated once
        expect(computedCallCount).toBe(1)
        expect(runs).toEqual([0])

        // Reset counter
        computedCallCount = 0

        // Change the underlying observable
        state.value = 5

        // With regular Reaction, shouldCompute() runs synchronously during runReaction_()
        // This calls computed.get() to check if the value changed, triggering recalculation
        expect(computedCallCount).toBe(1) // Computed was recalculated SYNCHRONOUSLY
        expect(runs).toEqual([0, 10]) // Reaction ran synchronously

        reaction.dispose()
    })

    test("ScheduledReaction: computed is NOT recalculated until scheduler fires", async () => {
        const scheduler = createNextTaskScheduler()
        let computedCallCount = 0
        const state = mobx.observable({ value: 0 })

        const derived = mobx.computed(() => {
            computedCallCount++
            return state.value * 2
        })

        const runs = []
        const reaction = new mobx.ScheduledReaction(
            "ScheduledReaction",
            function () {
                this.track(() => {
                    runs.push(derived.get())
                })
            },
            scheduler
        )
        reaction.schedule_()

        // Wait for initial run
        await new Promise(r => setTimeout(r, 0))

        // Initial run: computed is calculated once
        expect(computedCallCount).toBe(1)
        expect(runs).toEqual([0])

        // Reset counter
        computedCallCount = 0

        // Change the underlying observable
        state.value = 5

        // With ScheduledReaction, runReaction_() is NOT called synchronously
        // Therefore shouldCompute() hasn't run, and computed.get() hasn't been called
        expect(computedCallCount).toBe(0) // Computed was NOT recalculated yet!
        expect(runs).toEqual([0]) // Reaction hasn't run yet

        // Wait for scheduler to fire
        await new Promise(r => setTimeout(r, 0))

        // NOW the computed is recalculated (during shouldCompute() or track())
        expect(computedCallCount).toBe(1) // Computed recalculated when scheduler fired
        expect(runs).toEqual([0, 10]) // Reaction ran

        reaction.dispose()
    })

    test("ScheduledReaction defers shouldCompute() - verified by POSSIBLY_STALE state", async () => {
        // This test uses a manual scheduler to have fine-grained control
        let pendingReaction = null
        const manualScheduler = reaction => {
            pendingReaction = reaction
        }

        let computedCallCount = 0
        const state = mobx.observable({ value: 0 })

        const derived = mobx.computed(() => {
            computedCallCount++
            return state.value * 2
        })

        const runs = []
        const reaction = new mobx.ScheduledReaction(
            "ManualScheduledReaction",
            function () {
                this.track(() => {
                    runs.push(derived.get())
                })
            },
            manualScheduler
        )

        // Start the reaction - this triggers the scheduler
        reaction.schedule_()
        expect(pendingReaction).toBe(reaction)

        // Manually run the reaction
        pendingReaction.runReaction_()
        pendingReaction = null

        expect(computedCallCount).toBe(1)
        expect(runs).toEqual([0])

        // Reset
        computedCallCount = 0

        // Change the state - this should trigger scheduler but NOT run shouldCompute()
        state.value = 5

        // Scheduler was called, but we haven't run the reaction yet
        expect(pendingReaction).toBe(reaction)
        expect(reaction.isScheduled).toBe(true)

        // The computed has NOT been recalculated - shouldCompute() hasn't been called
        expect(computedCallCount).toBe(0)
        expect(runs).toEqual([0])

        // Now manually run the reaction
        pendingReaction.runReaction_()

        // NOW shouldCompute() ran, which triggered computed recalculation
        expect(computedCallCount).toBe(1)
        expect(runs).toEqual([0, 10])

        reaction.dispose()
    })

    test("Multiple state changes with ScheduledReaction: computed only recalculates once", async () => {
        const scheduler = createNextTaskScheduler()
        let computedCallCount = 0
        const state = mobx.observable({ value: 0 })

        const derived = mobx.computed(() => {
            computedCallCount++
            return state.value * 2
        })

        const runs = []
        const reaction = new mobx.ScheduledReaction(
            "BatchedScheduledReaction",
            function () {
                this.track(() => {
                    runs.push(derived.get())
                })
            },
            scheduler
        )
        reaction.schedule_()

        await new Promise(r => setTimeout(r, 0))
        expect(computedCallCount).toBe(1)
        computedCallCount = 0

        // Multiple rapid state changes
        state.value = 1
        state.value = 2
        state.value = 3
        state.value = 4
        state.value = 5

        // Computed hasn't been recalculated during any of these changes
        expect(computedCallCount).toBe(0)
        expect(runs).toEqual([0])

        // Wait for scheduler
        await new Promise(r => setTimeout(r, 0))

        // Computed was recalculated only ONCE with the final value
        expect(computedCallCount).toBe(1)
        expect(runs).toEqual([0, 10])

        reaction.dispose()
    })

    test("Multiple state changes with Regular Reaction: computed recalculates for EACH change", () => {
        let computedCallCount = 0
        const state = mobx.observable({ value: 0 })

        const derived = mobx.computed(() => {
            computedCallCount++
            return state.value * 2
        })

        const runs = []
        const reaction = new mobx.Reaction("UnbatchedRegularReaction", function () {
            this.track(() => {
                runs.push(derived.get())
            })
        })
        reaction.schedule_()

        expect(computedCallCount).toBe(1)
        computedCallCount = 0

        // Multiple rapid state changes - each triggers synchronous recalculation
        state.value = 1
        state.value = 2
        state.value = 3
        state.value = 4
        state.value = 5

        // Computed was recalculated for EACH state change
        expect(computedCallCount).toBe(5)
        // Reaction ran for each change
        expect(runs).toEqual([0, 2, 4, 6, 8, 10])

        reaction.dispose()
    })
})

describe("ScheduledReaction example: requestAnimationFrame scheduler", () => {
    // Mock requestAnimationFrame for testing
    let rafCallbacks = []
    let rafId = 0
    const originalRAF = global.requestAnimationFrame

    beforeEach(() => {
        rafCallbacks = []
        rafId = 0
        global.requestAnimationFrame = cb => {
            rafCallbacks.push(cb)
            return ++rafId
        }
    })

    afterEach(() => {
        global.requestAnimationFrame = originalRAF
    })

    function createRAFScheduler() {
        const pending = new Set()
        let frameRequested = false

        function scheduler(reaction) {
            pending.add(reaction)

            if (!frameRequested) {
                frameRequested = true
                requestAnimationFrame(() => {
                    frameRequested = false
                    const toRun = Array.from(pending)
                    pending.clear()
                    for (const r of toRun) {
                        r.runReaction_()
                    }
                })
            }
        }

        return scheduler
    }

    test("RAF scheduler batches multiple reactions", () => {
        const rafScheduler = createRAFScheduler()
        const runs1 = []
        const runs2 = []
        const state = mobx.observable({ x: 0, y: 0 })

        const reaction1 = new ScheduledReaction(
            "raf-1",
            function () {
                this.track(() => {
                    runs1.push(state.x)
                })
            },
            rafScheduler
        )

        const reaction2 = new ScheduledReaction(
            "raf-2",
            function () {
                this.track(() => {
                    runs2.push(state.y)
                })
            },
            rafScheduler
        )

        reaction1.schedule_()
        reaction2.schedule_()

        state.x = 1
        state.y = 1

        // Nothing run yet
        expect(runs1).toEqual([])
        expect(runs2).toEqual([])

        // Only one RAF should have been requested
        expect(rafCallbacks.length).toBe(1)

        // Simulate RAF firing
        rafCallbacks[0]()

        // Both reactions should have run
        expect(runs1).toEqual([1])
        expect(runs2).toEqual([1])

        reaction1.dispose()
        reaction2.dispose()
    })
})
