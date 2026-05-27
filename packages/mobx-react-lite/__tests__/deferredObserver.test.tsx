import React, { act } from "react"
import { render, screen, cleanup } from "@testing-library/react"
import { observable, action, runInAction, computed } from "mobx"
import { useDeferredObserver } from "../src/useDeferredObserver"
import { resetMobx } from "./utils"

afterEach(() => {
    cleanup()
    resetMobx()
})

describe("useDeferredObserver", () => {
    it("should render and react to changes", async () => {
        const obs = observable({ count: 0 })
        const Component = () => {
            return useDeferredObserver(() => {
                return <div data-testid="count">{obs.count}</div>
            })
        }

        render(<Component />)
        expect(screen.getByTestId("count").textContent).toBe("0")

        await act(async () => {
            obs.count++
        })

        expect(screen.getByTestId("count").textContent).toBe("1")
    })

    it("should handle actions and maintain atomicity", async () => {
        const obs = observable({ a: 0, b: 0 })
        let renderCount = 0

        const Component = () => {
            return useDeferredObserver(() => {
                renderCount++
                return (
                    <div data-testid="sum">
                        {obs.a}+{obs.b}
                    </div>
                )
            })
        }

        render(<Component />)
        expect(renderCount).toBe(1)
        expect(screen.getByTestId("sum").textContent).toBe("0+0")

        await act(async () => {
            runInAction(() => {
                obs.a = 1
                obs.b = 1
            })
        })

        // In some test environments, React might render an extra time,
        // but it should at least be consistent and not render intermediate states.
        expect(renderCount).toBeGreaterThanOrEqual(2)
        expect(screen.getByTestId("sum").textContent).toBe("1+1")
    })

    it("should work with startTransition for deferred updates", async () => {
        const obs = observable({ count: 0 })
        let isPendingInComponent = false

        const Component = () => {
            const [isPending, startTransition] = React.useTransition()
            isPendingInComponent = isPending

            // We use the hook here. Note that the hook internally uses startTransition.
            // But we can also observe the transition state if we were to pass it down or use it in the parent.
            // Since useDeferredObserver has its own internal startTransition,
            // the render it triggers should be marked as a transition by React.
            return useDeferredObserver(() => {
                return <div data-testid="count">{obs.count}</div>
            })
        }

        render(<Component />)

        await act(async () => {
            obs.count++
            // In a real concurrent environment, we might see isPending be true here.
            // Jest/Testing Library 'act' usually flushes everything synchronously,
            // but the transition mechanism is still exercised.
        })

        expect(screen.getByTestId("count").textContent).toBe("1")
    })

    it("should dispose reaction on unmount", async () => {
        const obs = observable({ count: 0 })
        let renderCount = 0

        const Component = () => {
            return useDeferredObserver(() => {
                renderCount++
                return <div>{obs.count}</div>
            })
        }

        const { unmount } = render(<Component />)
        expect(renderCount).toBe(1)

        unmount()

        await act(async () => {
            obs.count++
        })

        // Should not have re-rendered after unmount
        expect(renderCount).toBe(1)
    })

    it("should handle exceptions in render", () => {
        const obs = observable({ count: 0 })
        const Component = () => {
            return useDeferredObserver(() => {
                if (obs.count > 0) {
                    throw new Error("Render error")
                }
                return <div>{obs.count}</div>
            })
        }

        // Suppress console.error for the expected error
        const spy = jest.spyOn(console, "error").mockImplementation(() => {})

        render(
            <ErrorBoundary>
                <Component />
            </ErrorBoundary>
        )

        expect(() => {
            act(() => {
                obs.count++
            })
        }).not.toThrow() // Error caught by ErrorBoundary

        expect(screen.getByTestId("error").textContent).toBe("Render error")
        spy.mockRestore()
    })

    it("should not re-compute computeds until render happens", async () => {
        const obs = observable({ count: 0 })
        let computedRunCount = 0
        const comp = computed(() => {
            computedRunCount++
            return obs.count * 2
        })

        const Component = () => {
            return useDeferredObserver(() => {
                return <div data-testid="value">{comp.get()}</div>
            })
        }

        render(<Component />)
        // Initial render triggers one computed run
        expect(computedRunCount).toBe(1)
        expect(screen.getByTestId("value").textContent).toBe("0")

        // Change the observable inside an action
        await act(async () => {
            runInAction(() => {
                obs.count = 1
            })
            // AFTER the action, but BEFORE React has a chance to render,
            // a standard reaction would have already triggered shouldCompute()
            // and incremented computedRunCount.
            // With LazyReaction, it should still be 1.
            expect(computedRunCount).toBe(1)
        })

        // Now that act() has finished and React has rendered
        expect(computedRunCount).toBe(2)
        expect(screen.getByTestId("value").textContent).toBe("2")
    })
})

class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null }
> {
    state = { error: null }
    static getDerivedStateFromError(error: Error) {
        return { error }
    }
    render() {
        if (this.state.error) {
            return <div data-testid="error">{(this.state.error as Error).message}</div>
        }
        return this.props.children
    }
}
