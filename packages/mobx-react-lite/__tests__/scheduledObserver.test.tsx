import { act, cleanup, render, waitFor } from "@testing-library/react"
import * as mobx from "mobx"
import React from "react"

import {
    scheduledObserver,
    useScheduledObserver,
    createTimeoutScheduler,
    createRAFScheduler,
    observer
} from "../src"
import type { ReactionScheduler } from "mobx"

afterEach(cleanup)

// Helper to create a manual scheduler for precise control in tests
function createManualScheduler() {
    const pending: mobx.ScheduledReaction[] = []
    let flushPromiseResolve: (() => void) | null = null

    const scheduler: ReactionScheduler = reaction => {
        pending.push(reaction)
    }

    const flush = () => {
        const toRun = pending.splice(0)
        for (const r of toRun) {
            r.runReaction_()
        }
        if (flushPromiseResolve) {
            flushPromiseResolve()
            flushPromiseResolve = null
        }
    }

    const waitForFlush = () =>
        new Promise<void>(resolve => {
            flushPromiseResolve = resolve
        })

    return { scheduler, flush, pending, waitForFlush }
}

describe("scheduledObserver", () => {
    test("basic rendering works", () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        const Component = deferredObserver(function Component() {
            return <div data-testid="value">{store.value}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(getByTestId("value").textContent).toBe("1")
    })

    test("defers re-render until scheduler flushes", async () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush, pending } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        let renderCount = 0
        const Component = deferredObserver(function Component() {
            renderCount++
            return <div data-testid="value">{store.value}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(renderCount).toBe(1)
        expect(getByTestId("value").textContent).toBe("1")

        // Change the observable
        act(() => {
            store.value = 2
        })

        // Reaction is scheduled but component hasn't re-rendered yet
        expect(pending.length).toBeGreaterThan(0)
        expect(renderCount).toBe(1) // Still 1 - no re-render yet
        expect(getByTestId("value").textContent).toBe("1") // Still shows old value

        // Flush the scheduler
        act(() => {
            flush()
        })

        // Now component should have re-rendered
        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("2")
        })
    })

    test("batches multiple state changes into single re-render", async () => {
        const store = mobx.observable({ a: 1, b: 1 })
        const { scheduler, flush } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        let renderCount = 0
        const Component = deferredObserver(function Component() {
            renderCount++
            return (
                <div data-testid="value">
                    {store.a}-{store.b}
                </div>
            )
        })

        const { getByTestId } = render(<Component />)
        expect(renderCount).toBe(1)

        // Multiple state changes
        act(() => {
            store.a = 2
            store.b = 2
            store.a = 3
            store.b = 3
        })

        // Still no re-render
        expect(renderCount).toBe(1)

        // Flush
        act(() => {
            flush()
        })

        // Only one additional render with final values
        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("3-3")
        })
        // Render count should be 2 (initial + one re-render after flush)
        expect(renderCount).toBe(2)
    })

    test("works with forwardRef", async () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        const Component = deferredObserver(
            React.forwardRef<HTMLDivElement, {}>(function Component(props, ref) {
                return (
                    <div ref={ref} data-testid="value">
                        {store.value}
                    </div>
                )
            })
        )

        const ref = React.createRef<HTMLDivElement>()
        const { getByTestId } = render(<Component ref={ref} />)

        expect(ref.current).toBeInstanceOf(HTMLDivElement)
        expect(getByTestId("value").textContent).toBe("1")

        act(() => {
            store.value = 2
        })

        act(() => {
            flush()
        })

        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("2")
        })
    })

    test("computed values are not recalculated until scheduler flushes", async () => {
        const store = mobx.observable({ value: 1 })
        let computedCallCount = 0
        const derived = mobx.computed(() => {
            computedCallCount++
            return store.value * 2
        })

        const { scheduler, flush } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        const Component = deferredObserver(function Component() {
            return <div data-testid="value">{derived.get()}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(computedCallCount).toBe(1)
        expect(getByTestId("value").textContent).toBe("2")

        // Reset counter
        computedCallCount = 0

        // Change observable
        act(() => {
            store.value = 5
        })

        // Computed has NOT been recalculated yet (key benefit of ScheduledReaction!)
        expect(computedCallCount).toBe(0)

        // Flush scheduler
        act(() => {
            flush()
        })

        // Now computed is recalculated
        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("10")
        })
        expect(computedCallCount).toBe(1)
    })

    test("chained computed values are all deferred", async () => {
        const store = mobx.observable({ value: 1 })
        let computedCalls = { c1: 0, c2: 0, c3: 0 }

        const c1 = mobx.computed(() => {
            computedCalls.c1++
            return store.value * 2
        })
        const c2 = mobx.computed(() => {
            computedCalls.c2++
            return c1.get() * 2
        })
        const c3 = mobx.computed(() => {
            computedCalls.c3++
            return c2.get() * 2
        })

        const { scheduler, flush } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        const Component = deferredObserver(function Component() {
            return <div data-testid="value">{c3.get()}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(getByTestId("value").textContent).toBe("8") // 1 * 2 * 2 * 2

        // Reset counters
        computedCalls = { c1: 0, c2: 0, c3: 0 }

        // Change observable
        act(() => {
            store.value = 2
        })

        // None of the computeds have recalculated yet
        expect(computedCalls.c1).toBe(0)
        expect(computedCalls.c2).toBe(0)
        expect(computedCalls.c3).toBe(0)

        // Flush scheduler
        act(() => {
            flush()
        })

        // All computeds recalculated
        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("16") // 2 * 2 * 2 * 2
        })
        expect(computedCalls.c1).toBe(1)
        expect(computedCalls.c2).toBe(1)
        expect(computedCalls.c3).toBe(1)
    })

    test("disposes reaction on unmount", () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush, pending } = createManualScheduler()
        const deferredObserver = scheduledObserver(scheduler)

        const Component = deferredObserver(function Component() {
            return <div>{store.value}</div>
        })

        const { unmount } = render(<Component />)

        // Unmount
        unmount()

        // Change state - should not throw or cause issues
        act(() => {
            store.value = 2
        })

        // Flush should be safe
        act(() => {
            flush()
        })

        // No errors means success
    })
})

describe("useScheduledObserver", () => {
    test("basic rendering works", () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler } = createManualScheduler()

        function Component() {
            return useScheduledObserver(
                () => <div data-testid="value">{store.value}</div>,
                scheduler
            )
        }

        const { getByTestId } = render(<Component />)
        expect(getByTestId("value").textContent).toBe("1")
    })

    test("defers re-render until scheduler flushes", async () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush } = createManualScheduler()

        let renderCount = 0
        function Component() {
            return useScheduledObserver(() => {
                renderCount++
                return <div data-testid="value">{store.value}</div>
            }, scheduler)
        }

        const { getByTestId } = render(<Component />)
        expect(renderCount).toBe(1)

        act(() => {
            store.value = 2
        })

        // Not re-rendered yet
        expect(renderCount).toBe(1)

        act(() => {
            flush()
        })

        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("2")
        })
    })
})

describe("createTimeoutScheduler", () => {
    test("defers reactions to next macrotask", async () => {
        const store = mobx.observable({ value: 1 })
        const timeoutScheduler = createTimeoutScheduler()
        const deferredObserver = scheduledObserver(timeoutScheduler)

        let renderCount = 0
        const Component = deferredObserver(function Component() {
            renderCount++
            return <div data-testid="value">{store.value}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(renderCount).toBe(1)
        expect(getByTestId("value").textContent).toBe("1")

        // Change state
        act(() => {
            store.value = 2
        })

        // Still old value (deferred)
        expect(renderCount).toBe(1)

        // Wait for setTimeout to fire
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 10))
        })

        // Now updated
        expect(getByTestId("value").textContent).toBe("2")
    })
})

describe("createRAFScheduler", () => {
    // Mock requestAnimationFrame
    let rafCallback: (() => void) | null = null
    const originalRAF = globalThis.requestAnimationFrame

    beforeEach(() => {
        rafCallback = null
        globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
            rafCallback = () => cb(performance.now())
            return 1
        }
    })

    afterEach(() => {
        globalThis.requestAnimationFrame = originalRAF
    })

    test("defers reactions to next animation frame", async () => {
        const store = mobx.observable({ value: 1 })
        const rafScheduler = createRAFScheduler()
        const deferredObserver = scheduledObserver(rafScheduler)

        let renderCount = 0
        const Component = deferredObserver(function Component() {
            renderCount++
            return <div data-testid="value">{store.value}</div>
        })

        const { getByTestId } = render(<Component />)
        expect(renderCount).toBe(1)

        // Change state
        act(() => {
            store.value = 2
        })

        // Still old value
        expect(renderCount).toBe(1)
        expect(rafCallback).not.toBeNull()

        // Simulate RAF firing
        act(() => {
            rafCallback?.()
        })

        // Now updated
        await waitFor(() => {
            expect(getByTestId("value").textContent).toBe("2")
        })
    })
})

describe("comparison: observer vs scheduledObserver", () => {
    test("observer updates synchronously, scheduledObserver defers", async () => {
        const store = mobx.observable({ value: 1 })
        const { scheduler, flush } = createManualScheduler()

        // Regular observer
        let syncRenderCount = 0
        const SyncComponent = observer(function SyncComponent() {
            syncRenderCount++
            return <div data-testid="sync">{store.value}</div>
        })

        // Scheduled observer
        const deferredObserver = scheduledObserver(scheduler)
        let deferredRenderCount = 0
        const DeferredComponent = deferredObserver(function DeferredComponent() {
            deferredRenderCount++
            return <div data-testid="deferred">{store.value}</div>
        })

        const { getByTestId } = render(
            <>
                <SyncComponent />
                <DeferredComponent />
            </>
        )

        expect(syncRenderCount).toBe(1)
        expect(deferredRenderCount).toBe(1)

        // Change state
        act(() => {
            store.value = 2
        })

        // Sync component re-rendered immediately
        expect(syncRenderCount).toBe(2)
        expect(getByTestId("sync").textContent).toBe("2")

        // Deferred component has NOT re-rendered
        expect(deferredRenderCount).toBe(1)
        expect(getByTestId("deferred").textContent).toBe("1")

        // Flush deferred reactions
        act(() => {
            flush()
        })

        // Now deferred component has re-rendered
        await waitFor(() => {
            expect(getByTestId("deferred").textContent).toBe("2")
        })
        expect(deferredRenderCount).toBe(2)
    })
})
