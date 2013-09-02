"use strict";
var assert = require("assert");

var UNSET = { "unset": "UNSET" };

// NOTE!!! This is not normal JavaScript; it's used as a sanity check for the spec. JavaScript promises do not work this
// way, e.g. they have methods instead of these capitalized functions! Do not use this for anything real!

var ThenableCoercions = new WeakMap();

function Promise() {
    this._isPromise = true;
    this._following = UNSET;
    this._value = UNSET;
    this._reason = UNSET;
    this._derived = [];
}

function IsPromise(x) {
    return IsObject(x) && x._isPromise;
}

function Resolve(p, x) {
    if (is_set(p._following) || is_set(p._value) || is_set(p._reason)) {
        return;
    }

    if (IsPromise(x)) {
        if (SameValue(p, x)) {
            var selfResolutionError = new TypeError("Tried to resolve a promise with itself!");
            SetReason(p, selfResolutionError);
        } else if (is_set(x._following)) {
            p._following = x._following;
            x._following._derived.push({ derivedPromise: p, onFulfilled: undefined, onRejected: undefined });
        } else if (is_set(x._value)) {
            SetValue(p, x._value);
        } else if (is_set(x._reason)) {
            SetReason(p, x._reason);
        } else {
            p._following = x;
            x._derived.push({ derivedPromise: p, onFulfilled: undefined, onRejected: undefined });
        }
    } else {
        SetValue(p, x);
    }
}

function Reject(p, r) {
    if (is_set(p._following) || is_set(p._value) || is_set(p._reason)) {
        return;
    }

    SetReason(p, r);
}

function Then(p, onFulfilled, onRejected) {
    if (is_set(p._following)) {
        return Then(p._following, onFulfilled, onRejected);
    } else {
        var q = new Promise();
        var derived = { derivedPromise: q, onFulfilled: onFulfilled, onRejected: onRejected };
        if (is_set(p._value) || is_set(p._reason)) {
            UpdateDerived(derived, p);
        } else {
            p._derived.push(derived);
        }
        return q;
    }
}

function PropagateToDerived(p) {
    assert((is_set(p._value) && !is_set(p._reason)) || (is_set(p._reason) && !is_set(p._value)));

    p._derived.forEach(function (derived) {
        UpdateDerived(derived, p);
    });

    // As per the note in the spec, this is not necessary, as we can verify by commenting it out.
    p._derived = [];
}

function UpdateDerived(derived, originator) {
    assert((is_set(originator._value) && !is_set(originator._reason)) || (is_set(originator._reason) && !is_set(originator._value)));

    if (is_set(originator._value)) {
        if (IsObject(originator._value)) {
            QueueAMicrotask(function () {
                var then = UNSET;
                try {
                    then = originator._value.then;
                } catch (e) {
                    UpdateDerivedFromReason(derived, e);
                }

                if (is_set(then)) {
                    if (typeof then === "function") {
                        var coerced = CoerceThenable(originator._value, then);
                        if (is_set(coerced._value) || is_set(coerced._reason)) {
                            UpdateDerived(derived, coerced);
                        } else {
                            coerced._derived.push(derived);
                        }
                    } else {
                        UpdateDerivedFromValue(derived, originator._value);
                    }
                }
            });
        } else {
            UpdateDerivedFromValue(derived, originator._value);
        }
    } else if (is_set(originator._reason)) {
        UpdateDerivedFromReason(derived, originator._reason);
    }
}

function UpdateDerivedFromValue(derived, value) {
    if (IsCallable(derived.onFulfilled)) {
        CallHandler(derived.derivedPromise, derived.onFulfilled, value);
    } else {
        SetValue(derived.derivedPromise, value);
    }
}

function UpdateDerivedFromReason(derived, reason) {
    if (IsCallable(derived.onRejected)) {
        CallHandler(derived.derivedPromise, derived.onRejected, reason);
    } else {
        SetReason(derived.derivedPromise, reason);
    }
}

function CoerceThenable(thenable, then) {
    // Missing assert: execution context stack is empty. Very hard to test; maybe could use `(new Error()).stack`?

    if (ThenableCoercions.has(thenable)) {
        return ThenableCoercions.get(thenable);
    } else {
        var p = new Promise();

        var resolve = function (x) {
            Resolve(p, x);
        }
        var reject = function (r) {
            Reject(p, r);
        }

        try {
            then.call(thenable, resolve, reject);
        } catch (e) {
            Reject(p, e);
        }

        ThenableCoercions.set(thenable, p);

        return p;
    }
}

function CallHandler(derivedPromise, handler, argument) {
    QueueAMicrotask(function () {
        var v = UNSET;

        try {
            v = handler(argument);
        } catch (e) {
            Reject(derivedPromise, e);
        }

        if (is_set(v)) {
            Resolve(derivedPromise, v);
        }
    });
}

function SetValue(p, value) {
    assert(!is_set(p._value) && !is_set(p._reason));

    p._value = value;
    p._following = UNSET;
    PropagateToDerived(p);
}

function SetReason(p, reason) {
    assert(!is_set(p._value) && !is_set(p._reason));

    p._reason = reason;
    p._following = UNSET;
    PropagateToDerived(p);
}

//////
// ES/environment functions

function IsObject(x) {
    return (typeof x === "object" && x !== null) || typeof x === "function";
}

function IsCallable(x) {
    return typeof x === "function";
}

function SameValue(x, y) {
    return Object.is(x, y);
}

function QueueAMicrotask(func) {
    process.nextTick(function () {
        func();
    });
}

//////
// Internal helpers (for clarity)

function is_set(internalPropertyValue) {
    return internalPropertyValue !== UNSET;
}

//////
// Promises/A+ specification test adapter

function addThenMethod(specificationPromise) {
    specificationPromise.then = function (onFulfilled, onRejected) {
        return addThenMethod(Then(specificationPromise, onFulfilled, onRejected));
    };

    // A `done` method is useful for writing tests.
    specificationPromise.done = function (onFulfilled, onRejected) {
        return this.then(onFulfilled, onRejected).then(undefined, function (reason) {
            process.nextTick(function () {
                throw reason;
            });
        });
    };
    return specificationPromise;
}

exports.pending = function () {
    var promise = addThenMethod(new Promise());

    return {
        promise: promise,
        fulfill: function (value) {
            // NB: Promises/A+ tests never pass promises (or thenables) to the adapter's `fulfill` method, so using
            // `Resolve` is equivalent.
            Resolve(promise, value);
        },
        reject: function (reason) {
            Reject(promise, reason);
        }
    };
};
