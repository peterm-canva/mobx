import { forwardRef, memo } from "react"

import { isUsingStaticRendering } from "./staticRendering"
import { useDeferredObserver } from "./useDeferredObserver"

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

export function deferredObserver<P extends object>(
    baseComponent: React.FunctionComponent<P>
): React.FunctionComponent<P>

export function deferredObserver<P extends object, TRef = {}>(
    baseComponent: React.ForwardRefExoticComponent<
        React.PropsWithoutRef<P> & React.RefAttributes<TRef>
    >
): React.MemoExoticComponent<
    React.ForwardRefExoticComponent<React.PropsWithoutRef<P> & React.RefAttributes<TRef>>
>

/**
 * TODO comment
 */
export function deferredObserver<P extends object, TRef = {}>(
    baseComponent:
        | React.ForwardRefRenderFunction<TRef, P>
        | React.FunctionComponent<P>
        | React.ForwardRefExoticComponent<React.PropsWithoutRef<P> & React.RefAttributes<TRef>>
) {
    if (ReactMemoSymbol && baseComponent["$$typeof"] === ReactMemoSymbol) {
        throw new Error(
            `[mobx-react-lite] You are trying to use \`deferredObserver\` on a function component wrapped in either another \`observer\` or \`React.memo\`. The observer already applies 'React.memo' for you.`
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
        return useDeferredObserver(
            isPending => render({ ...props, isPending }, ref),
            baseComponentName
        )
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
