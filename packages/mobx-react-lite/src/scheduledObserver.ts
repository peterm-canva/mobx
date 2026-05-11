import { ReactionScheduler } from "mobx"
import { forwardRef, memo } from "react"

import { isUsingStaticRendering } from "./staticRendering"
import { useScheduledObserver } from "./useScheduledObserver"

const hasSymbol = typeof Symbol === "function" && Symbol.for
const isFunctionNameConfigurable =
    Object.getOwnPropertyDescriptor(() => {}, "name")?.configurable ?? false

// Using react-is had some issues (and operates on elements, not on types), see #608 / #609
const ReactForwardRefSymbol = hasSymbol
    ? Symbol.for("react.forward_ref")
    : typeof forwardRef === "function" && forwardRef((props: any) => null)["$$typeof"]

const ReactMemoSymbol = hasSymbol
    ? Symbol.for("react.memo")
    : typeof memo === "function" && memo((props: any) => null)["$$typeof"]

/**
 * Creates a scheduled observer HOC that uses ScheduledReaction to defer
 * reaction execution. This can improve UI responsiveness when observing
 * expensive computed values.
 *
 * @param scheduler - A ReactionScheduler that controls when reactions run
 * @returns An observer HOC that uses the provided scheduler
 *
 * @example
 * ```tsx
 * // Create a scheduler that defers to next animation frame
 * function createRAFScheduler(): ReactionScheduler {
 *   const pending = new Set<ScheduledReaction>()
 *   let scheduled = false
 *
 *   return (reaction) => {
 *     pending.add(reaction)
 *     if (!scheduled) {
 *       scheduled = true
 *       requestAnimationFrame(() => {
 *         scheduled = false
 *         const toRun = Array.from(pending)
 *         pending.clear()
 *         toRun.forEach(r => r.runReaction_())
 *       })
 *     }
 *   }
 * }
 *
 * const deferredObserver = scheduledObserver(createRAFScheduler())
 *
 * const MyComponent = deferredObserver(function MyComponent() {
 *   return <div>{store.expensiveComputedValue}</div>
 * })
 * ```
 */
export function scheduledObserver(scheduler: ReactionScheduler) {
    // Return an observer HOC factory
    function observerWithScheduler<P extends object>(
        baseComponent: React.FunctionComponent<P>
    ): React.FunctionComponent<P>

    function observerWithScheduler<P extends object, TRef = {}>(
        baseComponent: React.ForwardRefExoticComponent<
            React.PropsWithoutRef<P> & React.RefAttributes<TRef>
        >
    ): React.MemoExoticComponent<
        React.ForwardRefExoticComponent<React.PropsWithoutRef<P> & React.RefAttributes<TRef>>
    >

    function observerWithScheduler<P extends object, TRef = {}>(
        baseComponent:
            | React.ForwardRefRenderFunction<TRef, P>
            | React.FunctionComponent<P>
            | React.ForwardRefExoticComponent<React.PropsWithoutRef<P> & React.RefAttributes<TRef>>
    ) {
        if (ReactMemoSymbol && baseComponent["$$typeof"] === ReactMemoSymbol) {
            throw new Error(
                `[mobx-react-lite] You are trying to use \`scheduledObserver\` on a function component wrapped in either another \`observer\` or \`React.memo\`. The observer already applies 'React.memo' for you.`
            )
        }

        if (isUsingStaticRendering()) {
            return baseComponent
        }

        let useForwardRef = false
        let render = baseComponent

        const baseComponentName = baseComponent.displayName || baseComponent.name

        // If already wrapped with forwardRef, unwrap,
        // so we can patch render and apply memo
        if (ReactForwardRefSymbol && baseComponent["$$typeof"] === ReactForwardRefSymbol) {
            useForwardRef = true
            render = baseComponent["render"]
            if (typeof render !== "function") {
                throw new Error(
                    `[mobx-react-lite] \`render\` property of ForwardRef was not a function`
                )
            }
        }

        let observerComponent = (props: any, ref: React.Ref<TRef>) => {
            return useScheduledObserver(() => render(props, ref), scheduler, baseComponentName)
        }

        // Inherit original name and displayName
        ;(observerComponent as React.FunctionComponent).displayName = baseComponent.displayName

        if (isFunctionNameConfigurable) {
            Object.defineProperty(observerComponent, "name", {
                value: baseComponent.name,
                writable: true,
                configurable: true
            })
        }

        // Support legacy context: `contextTypes` must be applied before `memo`
        if ((baseComponent as any).contextTypes) {
            ;(observerComponent as React.FunctionComponent).contextTypes = (
                baseComponent as any
            ).contextTypes
        }

        if (useForwardRef) {
            // `forwardRef` must be applied prior `memo`
            observerComponent = forwardRef(observerComponent)
        }

        // memo; we are not interested in deep updates
        // in props; we assume that if deep objects are changed,
        // this is in observables, which would have been tracked anyway
        observerComponent = memo(observerComponent)

        copyStaticProperties(baseComponent, observerComponent)

        return observerComponent
    }

    return observerWithScheduler
}

// based on https://github.com/mridgway/hoist-non-react-statics/blob/master/src/index.js
const hoistBlackList: any = {
    $$typeof: true,
    render: true,
    compare: true,
    type: true,
    // Don't redefine `displayName`,
    // it's defined as getter-setter pair on `memo` (see #3192).
    displayName: true
}

function copyStaticProperties(base: any, target: any) {
    Object.keys(base).forEach(key => {
        if (!hoistBlackList[key]) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(base, key)!)
        }
    })
}
