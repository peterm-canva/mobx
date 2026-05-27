import { Reaction } from "mobx"
import React from "react"
import { printDebugValue } from "./utils/printDebugValue"
import { isUsingStaticRendering } from "./staticRendering"
import { observerFinalizationRegistry } from "./utils/observerFinalizationRegistry"

/**
 * A specialized Reaction that:
 * 1. Skips MobX's standard `shouldCompute` check (which re-calculates computeds).
 * 2. Notifies React that an update is needed.
 *
 * By overriding `schedule_`, we prevent this reaction from ever being added to MobX's
 * global `pendingReactions` queue. This means MobX will never attempt to run it or
 * check if its dependencies are stale via `shouldCompute`.
 *
 * Instead, re-computation of stale dependencies (like computed values) is deferred
 * until the React render phase, when `reaction.track(render)` is called.
 */
class LazyReaction extends Reaction {
    constructor(name: string, private notifyReact_: () => void) {
        super(name, () => {})
    }

    schedule_() {
        if (!this.isScheduled) {
            this.isScheduled = true
            this.notifyReact_()
        }
    }
}

type DeferredObserverAdministration = {
    reaction: LazyReaction | null
    name: string
}

export function useDeferredObserver<T>(
    render: (isPending: boolean) => T,
    baseComponentName: string = "observed"
): T {
    if (isUsingStaticRendering()) {
        return render(false)
    }

    const [, forceUpdate] = React.useReducer(c => c + 1, 0)
    const [isPending, startTransition] = React.useTransition()
    const admRef = React.useRef<DeferredObserverAdministration | null>(null)

    if (!admRef.current) {
        admRef.current = {
            reaction: null,
            name: baseComponentName
        }
    }

    const adm = admRef.current

    if (!adm.reaction || adm.reaction.isDisposed) {
        adm.reaction = new LazyReaction(`deferredObserver${adm.name}`, () => {
            startTransition(() => forceUpdate())
        })
        observerFinalizationRegistry.register(admRef, adm, adm.reaction)
    }

    const reaction = adm.reaction

    React.useEffect(() => {
        observerFinalizationRegistry.unregister(reaction)
        return () => {
            reaction.dispose()
        }
    }, [reaction])

    React.useDebugValue(reaction, printDebugValue)

    // Acknowledge that we are rendering, allowing future changes to trigger schedule_ again.
    reaction.isScheduled = false

    let renderResult!: T
    let exception
    reaction.track(() => {
        try {
            renderResult = render(isPending)
        } catch (e) {
            exception = e
        }
    })

    if (exception) {
        throw exception
    }

    return renderResult
}
